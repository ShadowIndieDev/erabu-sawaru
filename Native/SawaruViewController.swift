// SPDX-License-Identifier: GPL-3.0-or-later
// 「えらぶの窓」iPad版 0.1.10 の画面の受け手を元に、カメラと視線の処理を外し、
// 触れる操作を邪魔するもの（拡大・スクロール・端のスワイプ）を止めた。
import UIKit
import WebKit
import AVFoundation

private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var receiver: WKScriptMessageHandler?
    init(_ receiver: WKScriptMessageHandler) { self.receiver = receiver }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        receiver?.userContentController(userContentController, didReceive: message)
    }
}

final class SawaruViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, UIScrollViewDelegate, AVSpeechSynthesizerDelegate {
    private var webView: WKWebView!
    private var speechEngine: AVSpeechSynthesizer?
    private lazy var store = DocumentStore()
    private var speaker: AVSpeechSynthesizer {
        if let existing = speechEngine { return existing }
        let created = AVSpeechSynthesizer()
        created.delegate = self
        speechEngine = created
        return created
    }
    private let startupLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private var startupTimer: Timer?
    private var startupGeneration = 0
    private var webReady = false
    private var storeReadable = false
    private var inactive = false
    private var wantsAwake = true
    private var activeUtterances: Set<ObjectIdentifier> = []
    private var speechRemaining = 0

    private func isInternalPage(_ url: URL?) -> Bool {
        guard let url = url else { return false }
        return url.absoluteString == "about:blank" || (url.scheme == "https" && url.host == "sawaru.invalid" && url.path == "/")
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.95, green: 0.96, blue: 0.93, alpha: 1)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(WeakScriptHandler(self), name: "sawaru")
        configuration.dataDetectorTypes = []
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        // 拡大・スクロール・はね返りを止める（画面の中の設定の一覧だけは、ページ側でスクロールする）。
        let scroll = webView.scrollView
        scroll.isScrollEnabled = false
        scroll.bounces = false
        scroll.alwaysBounceVertical = false
        scroll.alwaysBounceHorizontal = false
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 1
        scroll.pinchGestureRecognizer?.isEnabled = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.delegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        startupLabel.numberOfLines = 0
        startupLabel.textAlignment = .center
        startupLabel.font = .preferredFont(forTextStyle: .title2)
        startupLabel.textColor = UIColor(red: 0.15, green: 0.24, blue: 0.22, alpha: 1)
        retryButton.tintColor = UIColor(red: 0.15, green: 0.37, blue: 0.34, alpha: 1)
        retryButton.setTitle("読み込み直す", for: .normal)
        retryButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retryButton.addTarget(self, action: #selector(retryStartup), for: .touchUpInside)
        let status = UIStackView(arrangedSubviews: [startupLabel, retryButton])
        status.axis = .vertical
        status.spacing = 24
        status.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(status)
        NSLayoutConstraint.activate([
            status.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            status.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 32),
            status.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -32)
        ])
        loadPage()
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
        setNeedsUpdateOfHomeIndicatorAutoHidden()
        applyAwake()
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
    }
    deinit { startupTimer?.invalidate() }

    // 拡大させない。
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { nil }

    @objc private func retryStartup() { stopSpeech(); loadPage() }
    private func loadPage() {
        startupGeneration += 1
        let generation = startupGeneration
        webReady = false
        storeReadable = false
        webView.stopLoading()
        webView.isHidden = true
        startupLabel.isHidden = false
        startupLabel.text = "準備しています… / ST-01"
        retryButton.isHidden = true
        startupTimer?.invalidate()
        guard let html = EmbeddedPage.html else {
            showFatal("ST-02: 同梱の画面データを読み取れませんでした。ZIPから開き直してください。")
            return
        }
        // 予約された .invalid のアドレスで、この画面を見分ける。ネットワークは使わない。
        webView.loadHTMLString(html, baseURL: URL(string: "https://sawaru.invalid/"))
        startupTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in
            guard let self = self, generation == self.startupGeneration else { return }
            self.showFatal("ST-03: 画面の開始を確認できませんでした。この画面の写真をお知らせください。")
        }
    }

    private func emit(_ event: [String: Any]) {
        guard webReady else { return }
        // 値はデータとして渡し、JavaScriptの文に埋め込まない。
        webView.callAsyncJavaScript("if (window.SawaruNative) { window.SawaruNative.onEvent(event); } return true;", arguments: ["event": event], in: nil, in: .page, completionHandler: { _ in })
    }
    private func bootstrap() {
        startupLabel.text = "保存したセットと設定を読み込んでいます… / ST-04"
        var data: [String: Any] = ["type": "bootstrap"]
        do {
            data["snapshot"] = try store.load()
            storeReadable = true
        } catch {
            // 読めないときは空のデータで上書きしない（ページが止まって知らせる）。
            data["loadError"] = true
            storeReadable = false
        }
        let generation = startupGeneration
        webReady = true
        webView.callAsyncJavaScript("if (!window.SawaruNative) { throw new Error('Bridge missing'); } await window.SawaruNative.bootstrap(event); return true;", arguments: ["event": data], in: nil, in: .page, completionHandler: { [weak self] result in
            guard let self = self, generation == self.startupGeneration else { return }
            switch result {
            case .success:
                self.startupTimer?.invalidate()
                self.webView.isHidden = false
                self.startupLabel.isHidden = true
                self.retryButton.isHidden = true
            case .failure(let error):
                self.showFatal("ST-05: 画面の初期化に失敗しました。\n" + error.localizedDescription)
            }
        })
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.webView === webView,
              isInternalPage(message.frameInfo.request.url),
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "ready" { bootstrap(); return }
        if type == "reload" { retryStartup(); return }
        guard webReady else { return }
        switch type {
        case "save":
            guard storeReadable, let snapshot = body["snapshot"] as? [String: Any] else {
                emit(["type": "saveError", "revision": body["revision"] as? Int ?? 0]); return
            }
            do { try store.save(snapshot: snapshot); emit(["type": "saved", "revision": body["revision"] as? Int ?? 0]) }
            catch { emit(["type": "saveError", "revision": body["revision"] as? Int ?? 0]) }
        case "speak":
            guard let text = body["text"] as? String, text.unicodeScalars.count <= 1000 else { return }
            speak(text, rate: (body["rate"] as? NSNumber)?.floatValue ?? 0.9)
        case "stopSpeech": stopSpeech()
        case "keepAwake":
            wantsAwake = (body["on"] as? Bool) ?? true
            applyAwake()
        case "export":
            if let text = body["text"] as? String, text.utf8.count <= 50 * 1024 * 1024 { exportText(text, name: body["name"] as? String) }
        default: break
        }
    }
    private func applyAwake() {
        UIApplication.shared.isIdleTimerDisabled = wantsAwake && !inactive && view.window != nil
    }

    func suspend() {
        guard isViewLoaded else { return }
        inactive = true
        emit(["type": "background"])
        stopSpeech()
        applyAwake()
    }
    func resume() {
        guard isViewLoaded else { return }
        let wasInactive = inactive
        inactive = false
        applyAwake()
        if wasInactive { emit(["type": "foreground"]) }
    }

    // 読み上げ。ページの速さ（0.5〜1.3倍、1が標準）を、iPadの標準の速さに掛ける。
    private func speak(_ text: String, rate: Float) {
        stopSpeech()
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard let voice = AVSpeechSynthesisVoice(language: "ja-JP") else {
            emit(["type": "speech", "state": "error", "message": "日本語の音声を使えません。iPadの読み上げの設定を確認してください。"]); return
        }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            emit(["type": "speech", "state": "error", "message": "音声を始められませんでした。音の出口を確認してください。"]); return
        }
        let factor = rate.isFinite ? min(1.3, max(0.5, rate)) : 0.9
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = min(0.65, max(0.25, AVSpeechUtteranceDefaultSpeechRate * factor))
        activeUtterances.insert(ObjectIdentifier(utterance))
        speechRemaining = 1
        speaker.speak(utterance)
    }
    private func stopSpeech() {
        let wasSpeaking = speechRemaining > 0 || (speechEngine?.isSpeaking ?? false)
        speechRemaining = 0
        activeUtterances.removeAll()
        speechEngine?.stopSpeaking(at: .immediate)
        guard wasSpeaking else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        guard activeUtterances.remove(ObjectIdentifier(utterance)) != nil else { return }
        speechRemaining = 0
        emit(["type": "speech", "state": "ended"])
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func exportText(_ text: String, name: String? = nil) {
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("SawaruExport", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            // ページからの名前は、文字・数字・-・_ だけを使う（パスにしない）。
            let safe = (name ?? "").filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
            let url = directory.appendingPathComponent((safe.isEmpty ? "えらぶの窓" : String(safe.prefix(60))) + ".erabu.json")
            try text.write(to: url, atomically: true, encoding: .utf8)
            let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            controller.popoverPresentationController?.sourceView = view
            controller.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            present(controller, animated: true)
        } catch { emit(["type": "exportError"]) }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard frame.isMainFrame, isInternalPage(frame.request.url) else { completionHandler(false); return }
        let alert = UIAlertController(title: "確認", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "キャンセル", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "続ける", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if isInternalPage(navigationAction.request.url), navigationAction.navigationType == .other {
            decisionHandler(.allow)
        } else { decisionHandler(.cancel) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        stopSpeech()
        webReady = false
        showFatal("ST-06: 画面の処理が中断しました。「読み込み直す」を押してください。")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        showFatal("ST-07: 画面を読み込めませんでした。\n" + error.localizedDescription)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        showFatal("ST-08: 画面の読み込みが中断しました。\n" + error.localizedDescription)
    }
    private func showFatal(_ message: String) {
        startupTimer?.invalidate()
        startupGeneration += 1
        webReady = false
        stopSpeech()
        webView.isHidden = true
        startupLabel.text = message
        startupLabel.isHidden = false
        retryButton.isHidden = false
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
import SwiftUI

@MainActor
private struct NativeScreen: UIViewControllerRepresentable {
    let isActive: Bool
    func makeUIViewController(context: Context) -> SawaruViewController {
        SawaruViewController()
    }
    func updateUIViewController(_ controller: SawaruViewController, context: Context) {
        if isActive { controller.resume() } else { controller.suspend() }
    }
}

@main
@MainActor
struct SawaruApp: App {
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            NativeScreen(isActive: scenePhase == .active)
                .ignoresSafeArea()
                // 画面の端からのスワイプは、1回目ではホームなどに移らないようにする（2回目で移る）。
                .defersSystemGestures(on: .all)
                // ホームに戻る線を隠す。
                .persistentSystemOverlays(.hidden)
                .statusBarHidden(true)
        }
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

// セット・写真・設定を、このアプリ専用の場所に1つのJSONで保存する。
// 元の「えらぶの窓」とは別の場所（ErabuSawaru）なので、互いの保存を壊さない。
final class DocumentStore {
    private let directory: URL
    private let file: URL
    private let maximumBytes = 60 * 1024 * 1024
    init() {
        directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ErabuSawaru", isDirectory: true)
        file = directory.appendingPathComponent("sets-v1.json")
    }
    private func valid(_ value: [String: Any]) -> Bool {
        (value["version"] as? Int) == 1 && value["sets"] is [Any] && value["prefs"] is [String: Any]
    }
    func load() throws -> [String: Any] {
        guard FileManager.default.fileExists(atPath: file.path) else {
            return ["version": 1, "sets": [Any](), "prefs": [String: Any]()]
        }
        let data = try Data(contentsOf: file)
        guard data.count <= maximumBytes,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any], valid(value) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return value
    }
    func save(snapshot: [String: Any]) throws {
        guard valid(snapshot), JSONSerialization.isValidJSONObject(snapshot) else { throw CocoaError(.fileWriteUnknown) }
        let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
        guard data.count <= maximumBytes else { throw CocoaError(.fileWriteOutOfSpace) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

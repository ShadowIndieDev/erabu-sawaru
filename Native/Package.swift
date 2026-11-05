// swift-tools-version: 5.7
// SPDX-License-Identifier: GPL-3.0-or-later
import PackageDescription
import AppleProductTypes

let package = Package(
    name: "ErabuSawaru",
    platforms: [.iOS("16.4")],
    products: [
        .iOSApplication(
            name: "えらぶの窓 さわる2択",
            targets: ["AppModule"],
            bundleIdentifier: "org.erabuwindow.ipad.sawaru2",
            displayVersion: "@VERSION@",
            bundleVersion: "@BUILD@",
            appIcon: .placeholder(icon: .star),
            accentColor: .presetColor(.green),
            supportedDeviceFamilies: [.pad],
            supportedInterfaceOrientations: [.landscapeLeft, .landscapeRight],
            capabilities: [.camera(purposeString: "セットの編集で、カードに使う写真を撮るときだけ使います。視線や顔の読み取りには使いません。")]
        )
    ],
    targets: [
        .executableTarget(name: "AppModule", path: ".", exclude: ["Web", "LICENSE.txt", "ASSET_NOTES.md"])
    ],
    swiftLanguageVersions: [.v5]
)

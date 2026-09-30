"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const helperRevision = "0a9072f1172bc46f1a33a2bc58b8df05cd8e81ef";
const productName = "BlueBubbles Preview";
const bundleId = "com.mishdivy.bluebubbles-preview";
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function previewSigningOptions(options) {
    return {
        ...options,
        identity: "-",
        identityValidation: false,
        // The pinned signer uses "none" to emit codesign --timestamp=none.
        optionsForFile: file => ({ ...options.optionsForFile?.(file), timestamp: "none" })
    };
}

function previewConfig({ revision, helper, checksum, output }) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Require a complete source revision.");
    const base = require("./electron-builder-config.js");
    return {
        ...base,
        productName,
        appId: bundleId,
        electronVersion: "25.9.8",
        npmRebuild: false,
        directories: { ...base.directories, output },
        extraMetadata: { main: "./dist/preview-bootstrap.cjs", version: `1.9.9-preview.${revision.slice(0, 7)}` },
        files: ["dist/**/*", "package.json"],
        extraResources: [
            {
                from: "appResources",
                to: "appResources",
                filter: [
                    "**/*",
                    "!private-api/macos11/BlueBubblesHelper.dylib",
                    "!private-api/macos11/BlueBubblesHelper.dylib.md5"
                ]
            },
            { from: helper, to: "appResources/private-api/macos11/BlueBubblesHelper.dylib" },
            { from: checksum, to: "appResources/private-api/macos11/BlueBubblesHelper.dylib.md5" }
        ],
        mac: {
            ...base.mac,
            entitlements: path.join(__dirname, "entitlements.mac.plist"),
            entitlementsInherit: path.join(__dirname, "entitlements.mac.plist"),
            target: [{ target: "dir", arch: ["arm64"] }],
            publish: null,
            signIgnore: [...base.mac.signIgnore, "BlueBubblesHelper\\.dylib$"],
            // Sign only this newly built preview; no vendor bundle or certificate is used.
            sign: options => require("@electron/osx-sign").signAsync(previewSigningOptions(options))
        }
    };
}

async function buildPreview(helperRoot) {
    if (process.platform !== "darwin" || process.arch !== "arm64")
        throw new Error("Requires an ARM64 macOS build runner.");
    const serverRoot = path.resolve(__dirname, "..");
    const repository = path.resolve(serverRoot, "../..");
    const revision = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const actualHelper = execFileSync("git", ["-C", helperRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (actualHelper !== helperRevision) throw new Error("Helper source revision differs from the reviewed build.");
    const helper = path.resolve(helperRoot, "build/messages/BlueBubblesHelper.dylib");
    execFileSync("codesign", ["--verify", "--strict", helper]);
    const architectures = execFileSync("lipo", ["-archs", helper], { encoding: "utf8" }).trim().split(/\s+/);
    if (!architectures.includes("arm64") || !architectures.includes("arm64e"))
        throw new Error("Helper lacks required slices.");
    const output = path.join(serverRoot, "preview-artifacts");
    fs.mkdirSync(output, { recursive: true });
    const checksum = path.join(output, "BlueBubblesHelper.dylib.md5");
    fs.writeFileSync(checksum, crypto.createHash("md5").update(fs.readFileSync(helper)).digest("hex"));
    fs.copyFileSync(path.join(__dirname, "preview-bootstrap.cjs"), path.join(serverRoot, "dist/preview-bootstrap.cjs"));
    fs.cpSync(path.join(repository, "packages/ui/build"), path.join(serverRoot, "dist"), { recursive: true });
    const builder = require("electron-builder");
    const config = previewConfig({ revision, helper, checksum, output: path.join(output, "packaged") });
    const sign = config.mac.sign;
    let signingHookRan = false;
    config.mac.sign = async options => {
        await sign(options);
        signingHookRan = true;
    };
    await builder.build({
        projectDir: serverRoot,
        targets: builder.Platform.MAC.createTarget("dir", builder.Arch.arm64),
        config,
        publish: "never"
    });
    if (!signingHookRan) throw new Error("Preview signing hook was not executed.");
    const app = path.join(output, "packaged/mac-arm64", `${productName}.app`);
    execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
    const asarFile = path.join(app, "Contents/Resources/app.asar");
    const asar = require("@electron/asar");
    const header = asar.getRawHeader(asarFile).headerString;
    const plist = require("plist").parse(fs.readFileSync(path.join(app, "Contents/Info.plist"), "utf8"));
    const headerHash = crypto.createHash("sha256").update(header).digest("hex");
    if (
        plist.ElectronAsarIntegrity?.["Resources/app.asar"]?.hash !== headerHash ||
        plist.CFBundleIdentifier !== bundleId
    ) {
        throw new Error("Preview bundle identity or generated ASAR integrity differs.");
    }
    const embeddedHelper = path.join(
        app,
        "Contents/Resources/appResources/private-api/macos11/BlueBubblesHelper.dylib"
    );
    if (hash(embeddedHelper) !== hash(helper)) throw new Error("Packaged helper differs from the reviewed build.");
    const archive = path.join(output, "BlueBubbles-Preview-arm64.zip");
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
    const manifest = {
        serverRevision: revision,
        helperRevision,
        productName,
        bundleId,
        version: `1.9.9-preview.${revision.slice(0, 7)}`,
        electronVersion: "25.9.8",
        architecture: "arm64",
        appRelativePath: `${productName}.app`,
        stateRelativeToAppData: "divy-mac-utils/services/bluebubbles-preview/data",
        executableName: productName,
        executableSha256: hash(path.join(app, "Contents/MacOS", productName)),
        infoPlistSha256: hash(path.join(app, "Contents/Info.plist")),
        archiveSha256: hash(archive),
        asarSha256: hash(asarFile),
        asarHeaderSha256: headerHash,
        mainSha256: hash(path.join(serverRoot, "dist/main.js")),
        bootstrapSha256: hash(path.join(__dirname, "preview-bootstrap.cjs")),
        helperSha256: hash(embeddedHelper),
        packageLockSha256: hash(path.join(repository, "package-lock.json")),
        signing: "ad-hoc; not notarized",
        nodeVersion: process.version,
        workflowRunId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        workflowRepository: process.env.GITHUB_REPOSITORY ?? null
    };
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(path.join(output, "SHA256SUMS"), `${manifest.archiveSha256}  ${path.basename(archive)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
}

module.exports = { previewConfig, previewSigningOptions, helperRevision };
if (require.main === module)
    buildPreview(process.argv[2]).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });

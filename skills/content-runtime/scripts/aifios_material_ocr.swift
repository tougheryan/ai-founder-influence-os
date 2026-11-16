import AppKit
import Foundation
import PDFKit
import Vision

private let defaultMaxPages = 40
private let hardMaxPages = 60
private let defaultMaxCharacters = 90_000
private let hardMaxCharacters = 180_000
private let longestPageSide = 2_400

private struct PageText: Encodable {
    let page: Int
    let text: String
}

private struct OCRPayload: Encodable {
    let ok = true
    let engine: String
    let pageCount: Int
    let processedPages: Int
    let text: String
    let warnings: [String]
}

private enum OCRFailure: Error, LocalizedError {
    case invalidArguments
    case unreadablePDF
    case emptyPDF
    case noRecognizableText

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "用法：aifios-material-ocr <PDF 路径> [--max-pages N] [--max-characters N]"
        case .unreadablePDF:
            return "PDF 无法打开或已损坏"
        case .emptyPDF:
            return "PDF 没有可读取页面"
        case .noRecognizableText:
            return "未能从 PDF 中读取到可用正文"
        }
    }
}

private func argumentValue(_ name: String, from values: [String], fallback: Int, maximum: Int) -> Int {
    guard let index = values.firstIndex(of: name), values.indices.contains(index + 1), let value = Int(values[index + 1]) else {
        return fallback
    }
    return min(max(1, value), maximum)
}

private func normalizedText(_ value: String) -> String {
    value
        .replacingOccurrences(of: "\u{0000}", with: "")
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func isUsableText(_ value: String) -> Bool {
    // A single decorative character is not a usable source for a content brief.
    value.unicodeScalars.filter { !$0.properties.isWhitespace }.count >= 8
}

private func pageImage(_ page: PDFPage) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { return nil }

    let scale = min(3.0, CGFloat(longestPageSide) / max(bounds.width, bounds.height))
    let imageSize = NSSize(
        width: max(1, (bounds.width * scale).rounded()),
        height: max(1, (bounds.height * scale).rounded())
    )
    let image = page.thumbnail(of: imageSize, for: .mediaBox)
    return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
}

private func recognizeText(in image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.minimumTextHeight = 0.008

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let observations = (request.results ?? []).sorted { lhs, rhs in
        let verticalDistance = lhs.boundingBox.midY - rhs.boundingBox.midY
        if abs(verticalDistance) > 0.018 {
            return lhs.boundingBox.midY > rhs.boundingBox.midY
        }
        return lhs.boundingBox.minX < rhs.boundingBox.minX
    }

    return normalizedText(observations.compactMap { observation in
        observation.topCandidates(1).first?.string
    }.joined(separator: "\n"))
}

private func boundedPages(_ pages: [PageText], maximumCharacters: Int) -> (pages: [PageText], text: String, wasTruncated: Bool) {
    var accepted: [PageText] = []
    var characterCount = 0
    var wasTruncated = false

    for page in pages {
        let remaining = maximumCharacters - characterCount
        if remaining <= 0 {
            wasTruncated = true
            break
        }
        let pageText = page.text.count > remaining ? String(page.text.prefix(remaining)) : page.text
        accepted.append(PageText(page: page.page, text: pageText))
        characterCount += pageText.count
        if pageText.count < page.text.count {
            wasTruncated = true
            break
        }
    }

    let text = accepted.map { "第 \($0.page) 页\n\($0.text)" }.joined(separator: "\n\n")
    return (accepted, text, wasTruncated)
}

private func emit(_ payload: OCRPayload) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = try encoder.encode(payload)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func run() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let sourcePath = arguments.first, !sourcePath.hasPrefix("--") else {
        throw OCRFailure.invalidArguments
    }

    let maxPages = argumentValue("--max-pages", from: arguments, fallback: defaultMaxPages, maximum: hardMaxPages)
    let maxCharacters = argumentValue("--max-characters", from: arguments, fallback: defaultMaxCharacters, maximum: hardMaxCharacters)
    guard let document = PDFDocument(url: URL(fileURLWithPath: sourcePath)) else {
        throw OCRFailure.unreadablePDF
    }
    guard document.pageCount > 0 else {
        throw OCRFailure.emptyPDF
    }

    let requestedPageCount = min(document.pageCount, maxPages)
    var warnings: [String] = []
    if document.pageCount > requestedPageCount {
        warnings.append("文档共 \(document.pageCount) 页，已按本期素材上限读取前 \(requestedPageCount) 页。")
    }

    var pages: [PageText] = []
    var usedVisionOCR = false
    for index in 0..<requestedPageCount {
        guard let page = document.page(at: index) else {
            warnings.append("第 \(index + 1) 页无法打开，已跳过。")
            continue
        }

        let embeddedText = normalizedText(page.string ?? "")
        if isUsableText(embeddedText) {
            pages.append(PageText(page: index + 1, text: embeddedText))
            continue
        }

        usedVisionOCR = true
        guard let image = pageImage(page) else {
            warnings.append("第 \(index + 1) 页无法渲染，已跳过。")
            continue
        }
        do {
            let text = try recognizeText(in: image)
            if isUsableText(text) {
                pages.append(PageText(page: index + 1, text: text))
            } else {
                warnings.append("第 \(index + 1) 页未识别到足够正文，已跳过。")
            }
        } catch {
            warnings.append("第 \(index + 1) 页 OCR 失败：\(error.localizedDescription)")
        }
    }

    let bounded = boundedPages(pages, maximumCharacters: maxCharacters)
    guard isUsableText(bounded.text) else {
        throw OCRFailure.noRecognizableText
    }
    if bounded.wasTruncated {
        warnings.append("正文过长，已按本期素材上限截取前 \(maxCharacters) 个字符。")
    }
    try emit(OCRPayload(
        engine: usedVisionOCR ? "macos-vision-ocr" : "pdfkit-text",
        pageCount: document.pageCount,
        processedPages: requestedPageCount,
        text: bounded.text,
        warnings: warnings
    ))
}

do {
    try run()
} catch {
    fputs("AIFIOS PDF OCR 失败：\(error.localizedDescription)\n", stderr)
    exit(2)
}

import { DocumentParser, DocumentMetadata } from './doc-parser.js';

export class UdfParser {
  static async parse(filePath: string): Promise<string> {
    return DocumentParser.parse(filePath);
  }

  static extractMetadataHeuristics(text: string, filename: string): DocumentMetadata {
    return DocumentParser.extractMetadataHeuristics(text, filename);
  }
}

import StreamZip from 'node-stream-zip';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

export interface DocumentMetadata {
  case_number?: string;
  court_name?: string;
  document_type?: string;
  plaintiff?: string;
  defendant?: string;
  summary?: string;
  tags?: string[];
}

export class DocumentParser {
  /**
   * Supported file extensions
   */
  static readonly SUPPORTED_EXTENSIONS = new Set(['.udf', '.docx', '.pdf', '.txt', '.text', '.md']);

  static isSupported(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.SUPPORTED_EXTENSIONS.has(ext);
  }

  /**
   * Parses document text according to its file extension.
   */
  static async parse(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    const ext = path.extname(filePath).toLowerCase();

    switch (ext) {
      case '.udf':
        return this.parseUdf(filePath);
      case '.docx':
        return this.parseDocx(filePath);
      case '.pdf':
        return this.parsePdf(filePath);
      case '.txt':
      case '.text':
      case '.md':
        return this.parseText(filePath);
      default:
        throw new Error(`Unsupported document extension: ${ext}`);
    }
  }

  /**
   * Reads a UDF file (which is a ZIP archive containing XML with CDATA),
   * or a plain text XML UDF file.
   */
  static async parseUdf(filePath: string): Promise<string> {
    let rawText = '';

    try {
      const zip = new StreamZip.async({ file: filePath });
      try {
        const entries = await zip.entries();
        const xmlEntryKey = Object.keys(entries).find(key => key.toLowerCase().endsWith('.xml'));
        if (xmlEntryKey) {
          const buffer = await zip.entryData(xmlEntryKey);
          rawText = buffer.toString('utf-8');
        }
      } finally {
        await zip.close();
      }
    } catch {
      // If zip extraction fails, check if the file is an uncompressed XML UDF file
      try {
        const content = await fsPromises.readFile(filePath, 'utf-8');
        if (content.trim().startsWith('<') || content.includes('<![CDATA[')) {
          rawText = content;
        }
      } catch {
        // Ignore fallback failure
      }
    }

    if (!rawText) {
      throw new Error('Geçersiz veya okunamayan UDF dosyası.');
    }

    // Extract CDATA if present
    const cdataRegex = /<!\[CDATA\[([\s\S]*?)\]\]>/i;
    const match = rawText.match(cdataRegex);
    let extracted = match ? match[1] : rawText;

    return this.cleanText(extracted);
  }

  /**
   * Parses Microsoft Word (.docx) documents using mammoth
   */
  static async parseDocx(filePath: string): Promise<string> {
    try {
      const result = await mammoth.extractRawText({ path: filePath });
      return this.cleanText(result.value);
    } catch (err: any) {
      throw new Error(`DOCX ayrıştırma hatası (${path.basename(filePath)}): ${err?.message || err}`);
    }
  }

  /**
   * Parses Adobe PDF (.pdf) documents using pdf-parse
   */
  static async parsePdf(filePath: string): Promise<string> {
    try {
      const dataBuffer = await fsPromises.readFile(filePath);
      const data = await pdfParse(dataBuffer);
      return this.cleanText(data.text);
    } catch (err: any) {
      throw new Error(`PDF ayrıştırma hatası (${path.basename(filePath)}): ${err?.message || err}`);
    }
  }

  /**
   * Reads plain text documents
   */
  static async parseText(filePath: string): Promise<string> {
    try {
      const text = await fsPromises.readFile(filePath, 'utf-8');
      return this.cleanText(text);
    } catch (err: any) {
      throw new Error(`Metin okuma hatası (${path.basename(filePath)}): ${err?.message || err}`);
    }
  }

  /**
   * Strips HTML/XML tags and normalizes whitespace
   */
  static cleanText(raw: string): string {
    if (!raw) return '';
    return raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim();
  }

  /**
   * Extracts Turkish legal metadata fields from document text body using patterns.
   */
  static extractMetadataHeuristics(text: string, filename: string): DocumentMetadata {
    const metadata: DocumentMetadata = {};
    if (!text) return metadata;

    const sample = text.slice(0, 3000);

    // 1. Court / Authority Name
    const courtRegexes = [
      /(?:T\.C\.\s+)?([A-ZÇĞİÖŞÜa-zçğıöşü\s\d.-]+(?:MAHKEMESİ(?:NE)?|HAKİMLİĞİ(?:NE)?|BAŞKANLIĞI(?:NA)?|İCRA\s+(?:DAİRESİ|MÜDÜRLÜĞÜ)(?:NE)?|CUMHURİYET\s+BAŞSAVCILIĞI(?:NA)?|KAYMAKAMLIĞI(?:NA)?|BAKANLIĞI(?:NA)?)(?:\s+[A-ZÇĞİÖŞÜa-zçğıöşü]+)?)/i,
      /((?:CUMHURİYET\s+BAŞSAVCILIĞINA|NÖBETÇİ\s+ASLİYE\s+HUKUK\s+MAHKEMESİNE)(?:\s+[A-ZÇĞİÖŞÜa-zçğıöşü]+)?)/i
    ];
    for (const cr of courtRegexes) {
      const match = sample.match(cr);
      if (match) {
        const val = match[1] || match[0];
        metadata.court_name = val.replace(/\s+/g, ' ').trim();
        break;
      }
    }

    // 2. Case / Esas / Karar / Soruşturma Number
    const caseRegexes = [
      /(?:ESAS\s*NO|DOSYA\s*NO|KARAR\s*NO|SORUŞTURMA\s*NO)\s*[:/]\s*([^\n;]+)/i,
      /(\d{4}\s*\/\s*\d+(?:\s*(?:E\.|K\.|Sor\.))?)/i
    ];
    for (const regex of caseRegexes) {
      const match = sample.match(regex);
      if (match) {
        metadata.case_number = match[1].replace(/\s+/g, ' ').trim();
        break;
      }
    }

    // 3. Parties (Plaintiff / Defendant / Requester / Complainant)
    const plaintiffRegex = /(?:DAVACI|MÜŞTEKİ|KATILAN|TALEPTE\s*BULUNAN|ŞİKAYETÇİ|VEKİLİ)\s*[:/]\s*([^\n;]+)/i;
    const plaintiffMatch = sample.match(plaintiffRegex);
    if (plaintiffMatch) {
      metadata.plaintiff = plaintiffMatch[1].split(';')[0].replace(/\s+/g, ' ').trim();
    }

    const defendantRegex = /(?:DAVALI|SANIK|ŞÜPHELİ|BORÇLU|KARŞI\s*TARAF)\s*[:/]\s*([^\n;]+)/i;
    const defendantMatch = sample.match(defendantRegex);
    if (defendantMatch) {
      metadata.defendant = defendantMatch[1].split(';')[0].replace(/\s+/g, ' ').trim();
    }

    // 4. Document Type / Subject
    const subjectRegex = /(?:KONU|TALEP\s*KONUSU|DAVA\s*TÜRÜ)\s*[:/]\s*([^\n;]+)/i;
    const subjectMatch = sample.match(subjectRegex);
    if (subjectMatch) {
      metadata.document_type = subjectMatch[1].slice(0, 150).replace(/\s+/g, ' ').trim();
    } else {
      const nameWithoutExt = filename.replace(/\.[^/.]+$/, "");
      metadata.document_type = nameWithoutExt.slice(0, 100).trim();
    }

    return metadata;
  }
}

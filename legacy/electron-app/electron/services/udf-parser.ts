import StreamZip from 'node-stream-zip';
import * as fs from 'fs';

export class UdfParser {
  /**
   * Reads a UDF file (which is a ZIP archive), extracts the XML entry,
   * retrieves the text body from the CDATA section, and strips tags.
   */
  static async parse(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    const zip = new StreamZip.async({ file: filePath });
    
    try {
      const entries = await zip.entries();
      
      // Look for any XML file inside the archive (typically content.xml)
      const xmlEntryKey = Object.keys(entries).find(key => key.toLowerCase().endsWith('.xml'));
      
      if (!xmlEntryKey) {
        throw new Error('Geçersiz UDF dosyası: İçerik XML dosyası bulunamadı.');
      }
      
      const buffer = await zip.entryData(xmlEntryKey);
      
      // Try UTF-8 decoding first.
      let xmlText = buffer.toString('utf-8');
      
      // Extract XML CDATA contents where actual text document lives
      const cdataRegex = /<!\[CDATA\[([\s\S]*?)\]\]>/i;
      const match = xmlText.match(cdataRegex);
      
      let rawText = match ? match[1] : xmlText;
      
      // Clean HTML/XML tags and normalize characters
      let cleanedText = rawText
        .replace(/<[^>]*>/g, ' ') // strip tags
        .replace(/&nbsp;/g, ' ')  // HTML whitespace entity
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\s+/g, ' ')     // normalize whitespaces
        .trim();
        
      return cleanedText;
    } catch (err: any) {
      throw new Error(`UDF ayrıştırma hatası: ${err?.message || err}`);
    } finally {
      await zip.close();
    }
  }

  /**
   * Extracts basic case metadata fields from document text body using patterns.
   */
  static extractMetadataHeuristics(text: string, filename: string): {
    case_number?: string;
    court_name?: string;
    document_type?: string;
    plaintiff?: string;
    defendant?: string;
    summary?: string;
    tags?: string[];
  } {
    const metadata: {
      case_number?: string;
      court_name?: string;
      document_type?: string;
      plaintiff?: string;
      defendant?: string;
      summary?: string;
      tags?: string[];
    } = {};

    if (!text) return metadata;

    // 1. Court Name
    const courtRegex = /(?:T\.C\.\s+)?([A-ZÇĞİÖŞÜa-zçğıöşü\s\d.-]+(?:MAHKEMESİ|HAKİMLİĞİ|BAŞKANLIĞI|İCRA DAİRESİ|İCRA MÜDÜRLÜĞÜ|CUMHURİYET BAŞSAVCILIĞI))/i;
    const courtMatch = text.slice(0, 1500).match(courtRegex);
    if (courtMatch) {
      metadata.court_name = courtMatch[1].replace(/\s+/g, ' ').trim();
    }

    // 2. Case / Esas Number
    const caseRegexes = [
      /(?:ESAS\s*NO|DOSYA\s*NO|KARAR\s*NO)\s*[:/]\s*(\d{4}\s*\/\s*\d+)/i,
      /(\d{4}\s*\/\s*\d+)\s*(?:ESAS|DOSYA|KARAR)/i
    ];
    for (const regex of caseRegexes) {
      const match = text.match(regex);
      if (match) {
        metadata.case_number = match[1].replace(/\s+/g, '').trim();
        break;
      }
    }

    // 3. Parties
    const plaintiffRegex = /(?:DAVACI|MÜŞTEKİ|KATILAN|ŞİKAYETÇİ|VEKİLİ)\s*:\s*([^\n]+)/i;
    const plaintiffMatch = text.match(plaintiffRegex);
    if (plaintiffMatch) {
      // Remove any trailing labels
      metadata.plaintiff = plaintiffMatch[1].split(';')[0].replace(/\s+/g, ' ').trim();
    }

    const defendantRegex = /(?:DAVALI|SANIK|ŞÜPHELİ)\s*:\s*([^\n]+)/i;
    const defendantMatch = text.match(defendantRegex);
    if (defendantMatch) {
      metadata.defendant = defendantMatch[1].split(';')[0].replace(/\s+/g, ' ').trim();
    }

    // 4. Document Type / Subject
    const subjectRegex = /(?:KONU|TALEP\s*KONUSU)\s*:\s*([^\n]+)/i;
    const subjectMatch = text.match(subjectRegex);
    if (subjectMatch) {
      metadata.document_type = subjectMatch[1].slice(0, 150).replace(/\s+/g, ' ').trim();
    } else {
      const nameWithoutExt = filename.replace(/\.[^/.]+$/, "");
      metadata.document_type = nameWithoutExt.slice(0, 100).trim();
    }

    return metadata;
  }
}

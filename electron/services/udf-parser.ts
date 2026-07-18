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
}

import StreamZip from 'node-stream-zip';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import WordExtractor from 'word-extractor';

export type CaseKind = 'ESAS' | 'SORUSTURMA' | 'DEGISIK_IS' | 'TAKIP' | 'BASVURU';

export interface DocumentMetadata {
  case_number?: string;
  case_kind?: CaseKind;
  court_name?: string;
  document_type?: string;
  document_date?: string;
  plaintiff?: string;
  defendant?: string;
  summary?: string;
  tags?: string[];
}

export class DocumentParser {
  /**
   * Supported file extensions
   */
  static readonly SUPPORTED_EXTENSIONS = new Set(['.udf', '.docx', '.doc', '.pdf', '.txt', '.text', '.md']);

  static isSupported(filePath: string): boolean {
    const filename = path.basename(filePath);
    if (filename.startsWith('~$') || filename.startsWith('._')) return false;
    const lower = filename.toLowerCase();
    if (lower.endsWith('.tmp') || lower === '.ds_store' || lower === 'thumbs.db') return false;

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
      case '.doc':
        return this.parseDoc(filePath);
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
   * Parses legacy Microsoft Word 97-2003 (.doc) binary documents using word-extractor
   */
  static async parseDoc(filePath: string): Promise<string> {
    try {
      const extractor = new WordExtractor();
      const extracted = await extractor.extract(filePath);
      const body = extracted.getBody() || '';
      return this.cleanText(body);
    } catch (err: any) {
      throw new Error(`DOC ayrıştırma hatası (${path.basename(filePath)}): ${err?.message || err}`);
    }
  }

  /**
   * Parses Adobe PDF (.pdf) documents using pdf-parse, silencing benign
   * PDF.js internal warnings (such as TT font bytecode hinting or missing glyf recovery).
   */
  static async parsePdf(filePath: string): Promise<string> {
    const origLog = console.log;
    const origWarn = console.warn;

    const filter = (...args: any[]) => {
      const msg = args.map(a => typeof a === 'string' ? a : (a?.message || '')).join(' ');
      if (
        msg.startsWith('Warning: TT:') ||
        msg.includes('Required "glyf" table is not found') ||
        msg.includes('Indexing all PDF objects') ||
        msg.startsWith('Warning: Indexing all PDF objects')
      ) {
        return; // Suppress benign font bytecode / recovery warnings from PDF.js
      }
      origLog.apply(console, args);
    };

    try {
      console.log = filter;
      console.warn = filter;

      const dataBuffer = await fsPromises.readFile(filePath);
      const data = await pdfParse(dataBuffer);
      return this.cleanText(data.text);
    } catch (err: any) {
      throw new Error(`PDF ayrıştırma hatası (${path.basename(filePath)}): ${err?.message || err}`);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
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
   * Extracts Turkish legal metadata fields from document text body and filename.
   * Body-first precedence: Text content is the primary source; UYAP filename evidence
   * serves as fallback when text is empty, sparse, or missing specific fields.
   */
  static extractMetadataHeuristics(text: string, filename: string): DocumentMetadata {
    const filenameWithoutExt = filename.replace(/\.[^/.]+$/, '').trim();
    const uyapEvidence = extractUyapFilenameEvidence(filenameWithoutExt);

    if (!text || text.trim().length === 0) {
      // Filename-only fallback
      return {
        case_number: uyapEvidence.case_number || undefined,
        case_kind: uyapEvidence.case_kind || undefined,
        document_type: uyapEvidence.document_type || (filenameWithoutExt.slice(0, 100) || undefined),
        document_date: uyapEvidence.document_date || undefined
      };
    }

    const metadata: DocumentMetadata = {};

    // 1. Authority / Court Name
    const rawLines = text.split(/\r?\n/);
    const headerLines = expandHeaderUnits(rawLines.slice(0, 50));
    let detectedCourt: string | null = null;
    let tcAnchor = false;

    for (let i = 0; i < headerLines.length; i++) {
      const line = headerLines[i];
      if (isTCLine(line)) {
        tcAnchor = true;
        continue;
      }
      for (const pattern of DEFAULT_AUTHORITY_PATTERNS) {
        const match = line.match(pattern.regex);
        if (match) {
          detectedCourt = normalizeAuthority(match[1] || match[0]);
          break;
        }
      }
      if (detectedCourt) break;
      if (isHeaderFieldLine(line)) {
        tcAnchor = false;
      }
    }

    if (detectedCourt) {
      metadata.court_name = detectedCourt;
    }

    // 2. Case Number and Case Kind
    const caseResult = extractCaseNumberFromText(text);
    if (caseResult) {
      metadata.case_number = caseResult.case_number;
      metadata.case_kind = caseResult.case_kind;
    } else if (uyapEvidence.case_number) {
      metadata.case_number = uyapEvidence.case_number;
      metadata.case_kind = uyapEvidence.case_kind || 'ESAS';
    }

    // 3. Document Type (Heading match -> Structural inference -> UYAP filename -> Subject -> clean filename)
    const typeFromHeading = extractDocumentTypeFromText(text);
    const typeFromStructure = !typeFromHeading ? inferDocumentTypeFromStructure(text) : null;
    
    if (typeFromHeading) {
      metadata.document_type = typeFromHeading;
    } else if (typeFromStructure) {
      metadata.document_type = typeFromStructure;
    } else if (uyapEvidence.document_type) {
      metadata.document_type = uyapEvidence.document_type;
    } else {
      // Check subject (KONU)
      const subjectMatch = text.slice(0, 3000).match(/(?:KONU|TALEP\s*KONUSU|DAVA\s*TÜRÜ)\s*[:/]\s*([^\n;]+)/i);
      if (subjectMatch) {
        metadata.document_type = subjectMatch[1].slice(0, 150).replace(/\s+/g, ' ').trim();
      } else {
        metadata.document_type = filenameWithoutExt.slice(0, 100).trim();
      }
    }

    // 4. Document Date
    const docDate = extractDocumentDate(text, metadata.document_type);
    if (docDate) {
      metadata.document_date = docDate;
    } else if (uyapEvidence.document_date) {
      metadata.document_date = uyapEvidence.document_date;
    }

    // 5. Parties (Plaintiff & Defendant / Accused / Debtor)
    const parties = extractParties(text);
    if (parties.plaintiff) {
      metadata.plaintiff = parties.plaintiff;
    }
    if (parties.defendant) {
      metadata.defendant = parties.defendant;
    }

    return metadata;
  }
}

// ---------------------------------------------------------------------------
// Helpers & Pattern Definitions (Field-Proven Legal Regex & Rules)
// ---------------------------------------------------------------------------

function turkishLower(input: string): string {
  return input
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLocaleLowerCase('tr-TR');
}

function cleanLine(line: string): string {
  return line
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^[|;:©]+\s*/, '')
    .replace(/MAHK\s+EMES([İI])/gi, 'MAHKEMES$1')
    .replace(/İCRA\s+D(?:\.|\s)+A[İI]RES([İI])/gi, 'İCRA DAİRES$1')
    .replace(/DEĞİŞİ\s+K\s+İŞ/gi, 'DEĞİŞİK İŞ')
    .replace(/\s+\d{2}[./-]\d{2}[./-]\d{4}\s*$/, '')
    .trim();
}

function isTCLine(line: string): boolean {
  return /^t\.?\s*c\.?$/i.test(line);
}

function isHeaderFieldLine(line: string): boolean {
  return /^(SAY[Iı]|KONU|[İIi]LG[İIi]|TAR[İIi]H)\s*:/i.test(line);
}

function expandHeaderUnits(rawLines: string[]): string[] {
  const units: string[] = [];
  for (const raw of rawLines) {
    for (const part of raw.split('\t')) {
      const cleaned = cleanLine(part).replace(/^t\.?\s*c\.?\s+/i, '');
      if (cleaned) units.push(cleaned);
    }
  }
  return units;
}

const DEFAULT_AUTHORITY_PATTERNS = [
  {
    id: 'uyap-icra-card',
    regex: /^\D?\s*\d{4}\s*\/\s*\d{1,7}\s+(.{3,100}?İCRA\s+DA[İIıi]RES[İIıi])\s*[-–—]\s*İCRA\s+DOSYAS[İIıi].*$/i
  },
  {
    id: 'appellate-origin',
    regex: /^(?:UYGULAMA|İLK\s+DERECE\s+MAHKEMESİ)\s*:\s*(.{3,100}?MAHKEMES[İI])['’]?\s*N[İI]N\b.*$/i
  },
  {
    id: 'authority-file-heading',
    regex: /^(.{3,100}?(?:MAHKEMESİ|BAŞSAVCILIĞI|İCRA\s+DAİRESİ))\s+\d{4}\s*\/\s*\d(?:\s*\d){0,6}\s+(?:ESAS|SORUŞTURMA|DEĞİŞİK\s+İŞ)?\s*DOSYASI\s*$/i
  },
  {
    id: 'authority-reference-heading',
    regex: /^(.{3,100}?(?:MAHKEMESİ|BAŞSAVCILIĞI|İCRA\s+DAİRESİ|İCRA\s+MÜDÜRLÜĞÜ))\s*[-–—]?\s*(?:ESAS|DOSYA|SORUŞTURMA|DEĞİŞİK\s+İŞ|TAKİP|BAŞVURU)\s*(?:NO\.?)?\s*[:][ \t]*\d{4}\s*\/\s*\d(?:\s*\d){0,6}\s*$/i
  },
  {
    id: 'authority-paired-reference',
    regex: /^(.{3,100}?(?:MAHKEMES(?:İ|I)|BAŞSAVCILIĞ(?:I|İ)|İCRA\s+DA[İI]RES(?:İ|I)|İCRA\s+M[ÜU]D[ÜU]RL[ÜU]Ğ[ÜU]|H[AÂ]K[İI]ML[İI]Ğ(?:İ|I)))\s*[-–—]?\s*\d{4}\s*\/\s*\d(?:\s*\d){0,6}(?:\s+(?:ESAS|E\.))?\s*$/i
  },
  {
    id: 'mahkemesi-sayi-header',
    regex: /^(.{3,80}?(?:MAHKEMES[İIi]|H[AÂ]K[İIıi]ML[İIıi]Ğ[İIıi]|BA(?:Ş|S)SAVC[Iı]L[Iı]Ğ[İIıi]))\s+SAY[Iı]\s*:\s*\d{4}\s*[\/-]\s*\d/i
  },
  { id: 'tahkim-komisyonu', regex: /^((?:.{0,40}?\s)?(?:S[İIıi]GORTA\s+)?TAHK[İIıi]M\s+KOM[İIıi]SYONU)(?:['’]?\s*N[AEae])?(?:\s+BAŞKANLIĞI)?/i },
  { id: 'hakem-heyeti', regex: /^((?:UYU[ŞS]MAZLIK|[İIıi]T[İIıi]RAZ)\s+HAKEM\s+HEYET[İIıi])(?:['’]?\s*N[AEae])?/i },
  { id: 'mahkemesine', regex: /^(.{3,100}?MAHKEMES(?:İ|I)(?:['’]?\s*(?:NE|NA))?)\s*$/i },
  { id: 'mahkemesi-kis', regex: /^(.{3,100}?\bMAHK\.)\s*$/i },
  { id: 'hakimligine', regex: /^(.{3,100}?H[AÂ]K[İI]ML[İI]Ğ(?:İ|I)(?:['’]?\s*(?:NE|NA))?)\s*$/i },
  { id: 'bassavciligina', regex: /^(.{3,100}?BA(?:Ş|S)SAVCILIĞ(?:I|İ)(?:['’]?\s*(?:NA|NE))?)\s*$/i },
  {
    id: 'dairesine',
    regex: /^(.{3,100}?DA[İI]RES(?:İ|I)(?:['’]?\s*(?:NE|NA))?)(?:\s+(?:ÖRNEK\s+NO\b.*|\d{2}[./-]\d{2}[./-]\d{4}.*))?\s*$/i
  },
  { id: 'mudurlugune', regex: /^(.{3,100}?M[ÜU]D[ÜU]RL[ÜU]Ğ[ÜU](?:'?(?:NE|NA))?)\s*$/i },
  { id: 'baskanligina', regex: /^(.{3,100}?BA(?:Ş|S)KANLIĞ(?:I|İ)(?:'?(?:NA|NE))?)\s*$/i }
];

function normalizeAuthority(raw: string): string {
  let val = raw.trim()
    .replace(/^t\.?\s*c\.?\s+/i, '')
    .replace(/['’]?\s*(?:ne|na)$/i, '')
    .replace(/\bMAHK\./gi, 'MAHKEMESİ')
    .replace(/\s+/g, ' ');
  return val;
}

function toCaseNumber(yearStr: string, seqStr: string): { year: number; sequence: number } | null {
  const year = parseInt(yearStr.replace(/[ \t]/g, ''), 10);
  const sequence = parseInt(seqStr.replace(/[ \t]/g, ''), 10);
  if (Number.isNaN(year) || Number.isNaN(sequence)) return null;
  if (year < 1980 || year > 2100) return null;
  if (sequence <= 0) return null;
  return { year, sequence };
}

function normalizeReferenceOcr(text: string): string {
  return turkishLower(text)
    .replace(/dosya[ \t]+n[ \t]*o\b/g, 'dosya no')
    .replace(/değişi[ \t]+k[ \t]+iş/g, 'değişik iş')
    .replace(/mah[ \t]*k[ \t]+emesi/g, 'mahkemesi')
    .replace(/icra[ \t]+d\.?[ \t]*airesi/g, 'icra dairesi');
}

const LABEL_KIND_PATTERNS = [
  { kind: 'ESAS' as const, regex: /(?<=^|\n)[ \t]*(?:esas|dosya)[ \t]*:[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})/g },
  { kind: 'SORUSTURMA' as const, regex: /(?<=^|\n)[ \t]*soruşturma[ \t]*:[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})/g },
  { kind: 'DEGISIK_IS' as const, regex: /(?<=^|\n)[ \t]*değişik[ \t]*iş[ \t]*:[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})/g },
  { kind: 'TAKIP' as const, regex: /(?<=^|\n)[ \t]*takip[ \t]*:[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})/g },
  { kind: 'ESAS' as const, regex: /(?:(?:esas|dosya)\s*no\.?|(?<![a-zçğıiöşü])e\.?\s*no\.?)\s*[:.\-]?\s*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})/g },
  { kind: 'SORUSTURMA' as const, regex: /soruşturma(?:[ \t]+defter)?[ \t]*no\.?[ \t]*[:.\-]?[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})/g },
  { kind: 'DEGISIK_IS' as const, regex: /değişik[ \t]*iş[ \t]*no\.?[ \t]*[:.\-]?[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})/g },
  { kind: 'TAKIP' as const, regex: /takip[ \t]*no\.?[ \t]*[:.\-]?[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})/g },
  { kind: 'BASVURU' as const, regex: /başvuru[ \t]*no\.?[ \t]*[:.\-]?[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})/g },
  { kind: 'BASVURU' as const, regex: /(?:dosya|başvuru)[ \t]*no\.?[ \t]*[:.\-]?[ \t]*(\d{4})[ \t]*[.\/ ][ \t]*e[ \t]*\.?[ \t]*(\d(?:[ \t]*\d){0,6})/g },
  { kind: 'BASVURU' as const, regex: /başvuru[ \t\r\n]+tarihi[ \t\r\n]+ve[ \t\r\n]+sayısı[ \t\r\n]*:?[ \t\r\n]*(?:\d{2}[./]\d{2}[./]\d{4}[ \t]*[-–][ \t]*)?(\d{4})[ \t]*\.?[ \t]*e\.?[ \t]*(\d{1,7})/g }
];

const SAYI_HEADER_PATTERNS = [
  { kind: 'ESAS' as const, regex: /sayı[ \t]*:[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})[ \t]+(?:esas|e\.)(?![a-zçğıöşü])/g },
  { kind: 'SORUSTURMA' as const, regex: /sayı[ \t]*:[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})[ \t]+soruşturma(?![a-zçğıöşü0-9])/g },
  { kind: 'DEGISIK_IS' as const, regex: /sayı[ \t]*:[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})[ \t]+(?:değişik[ \t]+iş|d\.[ \t]*iş)(?![a-zçğıöşü0-9])/g },
  { kind: 'TAKIP' as const, regex: /sayı[ \t]*:[ \t]*(\d{4})[ \t]*[\/-][ \t]*(\d(?:[ \t]*\d){0,6})[ \t]+takip(?![a-zçğıöşü0-9])/g }
];

const BARE_ESAS_REGEX = /(\S+)?[ \t]+(\d{4})[ \t]*\/[ \t]*(\d(?:[ \t]*\d){0,6})[ \t]+esas(?![a-zçğıöşü])/g;
const BARE_ESAS_CITATION_TAIL = /^\s*,?\s*sayılı\s+(karar|ilam|içtihat|dosya|dava|duruşma)/;
const AUTHORITY_STEM_BEFORE_NUMBER = /(mahkeme|hakimliğ|hâkimliğ|başsavcılığ|savcılığ|daire|müdürlüğ|komisyon|heyet)/;

function extractCaseNumberFromText(text: string): { case_number: string; case_kind: CaseKind } | null {
  const lowered = normalizeReferenceOcr(text);
  const candidates: { caseNumber: { year: number; sequence: number }; kind: CaseKind; index: number; structural: boolean }[] = [];

  for (const { kind, regex } of LABEL_KIND_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(lowered)) !== null) {
      const cn = toCaseNumber(match[1], match[2]);
      if (!cn) continue;
      const lineStart = lowered.lastIndexOf('\n', match.index - 1) + 1;
      const prefixOnLine = lowered.slice(lineStart, match.index).trim();
      candidates.push({ caseNumber: cn, kind, index: match.index, structural: prefixOnLine.length === 0 });
    }
  }

  const zone = lowered.slice(0, 3000);
  for (const { kind, regex } of SAYI_HEADER_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(zone)) !== null) {
      const cn = toCaseNumber(match[1], match[2]);
      if (cn) candidates.push({ caseNumber: cn, kind, index: match.index, structural: true });
    }
  }

  // Bare esas check while guarding against citations
  BARE_ESAS_REGEX.lastIndex = 0;
  let match;
  while ((match = BARE_ESAS_REGEX.exec(zone)) !== null) {
    const numberIndex = match.index + match[0].indexOf(match[2]);
    const rawWindow = zone.slice(Math.max(0, numberIndex - 45), numberIndex);
    const before = rawWindow.slice(rawWindow.lastIndexOf('\n') + 1);
    if (AUTHORITY_STEM_BEFORE_NUMBER.test(before)) continue;
    if (BARE_ESAS_CITATION_TAIL.test(zone.slice(match.index + match[0].length))) continue;
    const cn = toCaseNumber(match[2], match[3]);
    if (cn) {
      candidates.push({ caseNumber: cn, kind: 'ESAS', index: numberIndex, structural: false });
    }
  }

  if (candidates.length > 0) {
    const strong = candidates.filter((c) => c.structural);
    const primary = [...(strong.length > 0 ? strong : candidates)].sort((a, b) => a.index - b.index)[0];
    return {
      case_number: `${primary.caseNumber.year}/${primary.caseNumber.sequence}`,
      case_kind: primary.kind
    };
  }

  return null;
}

function cleanPartyValue(value: string): string {
  return value
    .replace(/\([^)]*(?:tckn|vkn|tc\s*kimlik|vergi|sicil|adres|no)[^)]*\)/gi, ' ')
    .replace(/\s+[-–—]\s+\d{6,}\s*[-–—]?.*$/g, '')
    .replace(/,\s*(?:t\.?c\.?\s*kimlik|tckn|vkn|vergi)\s*(?:\/\s*yupass)?\s*(?:no)?\s*[:.]?.*$/i, '')
    .replace(/\s+(?:t\.?c\.?\s*kimlik|tckn|vkn|vergi)\s*(?:\/\s*yupass)?\s*(?:no)?\s*[:.]?.*$/i, '')
    .replace(/,\s*adres\s*[:.]?.*$/i, '')
    .replace(/\s+adres\s*[:.]?.*$/i, '')
    .replace(/,.*\b(?:kızı|oğlu|doğumlu|t\.?c\.?\s*kimlik)\b.*$/i, '')
    .replace(/\s+[-–—|]+\s*$/g, '')
    .replace(/^\s*\d+[.)-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const PARTY_ROLES = [
  'DAVACI',
  'DAVACILAR',
  'DAVALI',
  'DAVALILAR',
  'MÜVEKKİL',
  'MÜŞTEKİ',
  'ŞİKAYETÇİ',
  'ŞİKÂYETÇİ',
  'ŞÜPHELİ',
  'SANIK',
  'SANIKLAR',
  'KATILAN',
  'MAĞDUR',
  'BORÇLU',
  'ALACAKLI',
  'BAŞVURAN',
  'BAŞVURUCU',
  'BAŞVURU SAHİBİ',
  'SİGORTA KURULUŞU',
  'İTİRAZ EDEN',
  'KARŞI TARAF',
  'TALEP EDEN'
];

function extractParties(text: string): { plaintiff?: string; defendant?: string } {
  const result: { plaintiff?: string; defendant?: string } = {};
  const lines = text.split(/\r?\n/).slice(0, 100);

  const plaintiffRoles = ['DAVACI', 'MÜŞTEKİ', 'ŞİKAYETÇİ', 'ŞİKÂYETÇİ', 'KATILAN', 'BAŞVURU SAHİBİ', 'BAŞVURAN', 'ALACAKLI', 'TALEP EDEN'];
  const defendantRoles = ['DAVALI', 'ŞÜPHELİ', 'SANIK', 'BORÇLU', 'SİGORTA KURULUŞU', 'KARŞI TARAF'];

  for (const rawLine of lines) {
    const match = rawLine.match(/^\s*([^:\t]{2,70})\s*[:\t]+\s*(.*)$/);
    if (!match) continue;
    const label = match[1].trim().toLocaleUpperCase('tr-TR');
    const rawVal = match[2];

    // Counsel lines are not parties
    if (/(?:VEK[İIıi]L|M[ÜUuü]DAF[İIıi])/i.test(label)) continue;

    const cleaned = cleanPartyValue(rawVal);
    if (!cleaned || cleaned.length < 2) continue;

    if (!result.plaintiff && plaintiffRoles.some((role) => label.includes(role))) {
      result.plaintiff = cleaned;
    } else if (!result.defendant && defendantRoles.some((role) => label.includes(role))) {
      result.defendant = cleaned;
    }
  }

  return result;
}

const DEFAULT_DOCUMENT_TYPE_RULES: { rawType: string; canonicalType: string }[] = [
  { rawType: 'Dava Dilekçesi', canonicalType: 'Dava Dilekçesi' },
  { rawType: 'Cevap Dilekçesi', canonicalType: 'Cevap Dilekçesi' },
  { rawType: 'İkinci Cevap Dilekçesi', canonicalType: 'İkinci Cevap Dilekçesi' },
  { rawType: 'Cevaba Cevap Dilekçesi', canonicalType: 'Cevaba Cevap Dilekçesi' },
  { rawType: 'Beyan Dilekçesi', canonicalType: 'Beyan Dilekçesi' },
  { rawType: 'Karşı Dava Dilekçesi', canonicalType: 'Karşı Dava Dilekçesi' },
  { rawType: 'Islah Dilekçesi', canonicalType: 'Islah Dilekçesi' },
  { rawType: 'Değişik İş Başvuru Dilekçesi', canonicalType: 'Değişik İş Başvuru Dilekçesi' },
  { rawType: 'Tutukluluk Halinin Devamı Kararına İtiraz Dilekçesi', canonicalType: 'Tutukluluk Halinin Devamı Kararına İtiraz Dilekçesi' },
  { rawType: 'Borca İtiraz Talebi', canonicalType: 'Borca İtiraz' },
  { rawType: 'İtiraz Dilekçesi', canonicalType: 'İtiraz Dilekçesi' },
  { rawType: 'İstinaf Başvuru Dilekçesi', canonicalType: 'İstinaf Başvuru Dilekçesi' },
  { rawType: 'İstinaf Dilekçesi', canonicalType: 'İstinaf Başvuru Dilekçesi' },
  { rawType: 'İstinafa Cevap Dilekçesi', canonicalType: 'İstinafa Cevap Dilekçesi' },
  { rawType: 'Temyiz Başvuru Dilekçesi', canonicalType: 'Temyiz Başvuru Dilekçesi' },
  { rawType: 'Temyiz Dilekçesi', canonicalType: 'Temyiz Başvuru Dilekçesi' },
  { rawType: 'Temyize Cevap Dilekçesi', canonicalType: 'Temyize Cevap Dilekçesi' },
  { rawType: 'Gerekçeli Karar Evrakı', canonicalType: 'Gerekçeli Karar' },
  { rawType: 'Gerekçeli Karar', canonicalType: 'Gerekçeli Karar' },
  { rawType: 'Karar İlamı', canonicalType: 'Gerekçeli Karar' },
  { rawType: 'Gerekçeli Karar İlamı', canonicalType: 'Gerekçeli Karar' },
  { rawType: 'Ara Karar Evrakı', canonicalType: 'Ara Karar' },
  { rawType: 'Ara Karar', canonicalType: 'Ara Karar' },
  { rawType: 'İstinaf İlamı', canonicalType: 'İstinaf İlamı' },
  { rawType: 'BAM İlamı', canonicalType: 'İstinaf İlamı' },
  { rawType: 'Temyiz İlamı', canonicalType: 'Temyiz İlamı' },
  { rawType: 'Yargıtay İlamı', canonicalType: 'Temyiz İlamı' },
  { rawType: 'Rapor', canonicalType: 'Bilirkişi Raporu' },
  { rawType: 'Bilirkişi Raporu', canonicalType: 'Bilirkişi Raporu' },
  { rawType: 'Bilirkişi Raporuna İtiraz Dilekçesi', canonicalType: 'Bilirkişi Raporuna İtiraz Dilekçesi' },
  { rawType: 'Bilirkişi Raporuna Karşı Beyan Dilekçesi', canonicalType: 'Bilirkişi Raporuna Karşı Beyan Dilekçesi' },
  { rawType: 'Duruşma Tutanağı', canonicalType: 'Duruşma Tutanağı' },
  { rawType: 'Duruşma Zaptı', canonicalType: 'Duruşma Tutanağı' },
  { rawType: 'Tensip Zaptı', canonicalType: 'Tensip Zaptı' },
  { rawType: 'Tensip Tutanağı', canonicalType: 'Tensip Zaptı' },
  { rawType: 'İfade Tutanağı', canonicalType: 'İfade Tutanağı' },
  { rawType: 'Şikayetçi İfade Tutanağı', canonicalType: 'İfade Tutanağı' },
  { rawType: 'Emanet Eşya Makbuzu', canonicalType: 'Emanet Eşya Makbuzu' },
  { rawType: 'Tebliğ Mazbatası', canonicalType: 'Tebligat Parçası' },
  { rawType: 'Tebligat Mazbatası', canonicalType: 'Tebligat Parçası' },
  { rawType: 'Tebligat', canonicalType: 'Tebligat Parçası' },
  { rawType: 'Müzekkere', canonicalType: 'Müzekkere' },
  { rawType: 'Müzekkere Cevabı', canonicalType: 'Müzekkere Cevabı' },
  { rawType: 'Harç Makbuzu', canonicalType: 'Harç Makbuzu' },
  { rawType: 'Gider Avansı Makbuzu', canonicalType: 'Gider Avansı Makbuzu' },
  { rawType: 'Eksper Raporu', canonicalType: 'Eksper Raporu' },
  { rawType: 'Trafik Kazası Tespit Tutanağı', canonicalType: 'Trafik Kazası Tespit Tutanağı' },
  { rawType: 'Kaza Tespit Tutanağı', canonicalType: 'Trafik Kazası Tespit Tutanağı' },
  { rawType: 'Vekaletname', canonicalType: 'Vekaletname' },
  { rawType: 'Mirasçılık Belgesi', canonicalType: 'Mirasçılık Belgesi' },
  { rawType: 'Takipsizlik Kararı', canonicalType: 'Takipsizlik Kararı' },
  { rawType: 'Takipsizlik', canonicalType: 'Takipsizlik Kararı' },
  { rawType: 'KYOK', canonicalType: 'Takipsizlik Kararı' },
  { rawType: 'Kovuşturmaya Yer Olmadığına Dair Karar', canonicalType: 'Takipsizlik Kararı' },
  { rawType: 'Kovuşturmaya Yer Olmadığı Kararı', canonicalType: 'Takipsizlik Kararı' },
  { rawType: 'Değişik İş Kararı', canonicalType: 'Değişik İş Kararı' }
];

function normalizeRawTypeKey(s: string): string {
  return turkishLower(s)
    .replace(/[^a-z0-9çğıöşü]+/g, ' ')
    .trim();
}

function extractDocumentTypeFromText(text: string): string | null {
  const lines = text.split(/\r?\n/).slice(0, 80);
  for (const line of lines) {
    const normalized = normalizeRawTypeKey(line);
    if (!normalized || normalized.length > 80) continue;
    for (const rule of DEFAULT_DOCUMENT_TYPE_RULES) {
      const ruleKey = normalizeRawTypeKey(rule.rawType);
      if (normalized === ruleKey || normalized === `${ruleKey}dir` || normalized === `${ruleKey}idir`) {
        return rule.canonicalType;
      }
    }
  }
  return null;
}

const PETITION_CLOSING = /\barz\s+(?:ve\s+talep\s+)?eder(?:im|iz)\b|\btalep\s+eder(?:im|iz)\b|\bsayg[ıi]lar[ıi]mla\b/i;

const STRUCTURAL_RULES = [
  {
    canonicalType: 'Cevap Dilekçesi',
    families: [
      { patterns: [/(?:cevap\s+dilekçe|cevaplar[ıi]m[ıi]z|savunmalar[ıi]m[ıi]z)/] },
      { patterns: [/(?:daval[ıi]\s+vekil[ıi]|cevap\s+veren|müvekkil(?:im)?\s+daval[ıi])/] },
      { patterns: [/(?:davan[ıi]n\s+(?:esastan\s+)?reddi|haks[ıi]z\s+ve\s+mesnetsiz|husumet\s+yoklu[ğg]u|zamana[şs][ıi]m[ıi]\s+itiraz)/] }
    ],
    guards: [/(?:gere[ğg]i\s+d[üu][şs][üu]n[üu]ld[üu]|^\s*h[üu]k[üu]m\s*:|dava\s+dilekçesidir)/]
  },
  {
    canonicalType: 'Gerekçeli Karar',
    families: [
      { patterns: [/(?:gere[ğg]i\s+d[üu][şs][üu]n[üu]ld[üu]|karar\s+ver[iı]lm[iı][şs]t[iı]r)/] },
      { patterns: [/^\s*h[üu]k[üu]m\s*:?/m, /^\s*hükümler\s*:/m] },
      { patterns: [/(?:karar\s*(?:no|numaras[ıi])\s*[:\-]|esas\s*no\s*[:\-].*karar\s*no\s*[:\-])/] }
    ],
    guards: [PETITION_CLOSING, /emsal\s+karar/, /say[ıi]l[ıi]\s+karar[ıi]nda/]
  },
  {
    canonicalType: 'Bilirkişi Raporuna İtiraz Dilekçesi',
    families: [
      { patterns: [/(?:bilirki[şs]i\s+raporuna\s+(?:kar[şs][ıi]\s+)?itiraz|rapora\s+itiraz)/] },
      { patterns: [/(?:itirazlar[ıi]m[ıi]z|beyanlar[ıi]m[ıi]z|kabul\s+etmiyoruz)/] },
      { patterns: [/(?:ek\s+rapor|yeni(?:den)?\s+bilirki[şs]i|ba[şs]ka\s+bir\s+bilirki[şs]i\s+heyeti)/] }
    ],
    guards: [/(?:gere[ğg]i\s+d[üu][şs][üu]n[üu]ld[üu]|^\s*h[üu]k[üu]m\s*:)/]
  }
];

function inferDocumentTypeFromStructure(text: string): string | null {
  const lowered = turkishLower(text);
  for (const rule of STRUCTURAL_RULES) {
    if (rule.guards.some((g) => g.test(lowered))) continue;
    let satisfied = 0;
    for (const family of rule.families) {
      if (family.patterns.some((p) => p.test(lowered))) satisfied++;
    }
    if (satisfied >= 2) {
      return rule.canonicalType;
    }
  }
  return null;
}

const DATE_PROXIMITY_KEYWORDS: Record<string, string[]> = {
  'Duruşma Tutanağı': ['duruşma tarihi', 'celse tarihi', 'duruşma günü'],
  'Gerekçeli Karar': ['karar tarihi', 'karar tarih'],
  'Bilirkişi Raporu': ['rapor tarihi'],
  Tebligat: ['tebliğ tarihi', 'tebellüğ tarihi']
};

function extractDocumentDate(text: string, canonicalType?: string): string | null {
  const dateRegex = /\b(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{4})\b/g;
  const lower = turkishLower(text);

  if (canonicalType && DATE_PROXIMITY_KEYWORDS[canonicalType]) {
    const keywords = DATE_PROXIMITY_KEYWORDS[canonicalType];
    for (const kw of keywords) {
      const idx = lower.indexOf(kw);
      if (idx !== -1) {
        const window = text.slice(idx, idx + 100);
        dateRegex.lastIndex = 0;
        const match = dateRegex.exec(window);
        if (match) {
          const d = match[1].padStart(2, '0');
          const m = match[2].padStart(2, '0');
          return `${d}.${m}.${match[3]}`;
        }
      }
    }
  }

  // General search for dates near common date labels
  const generalKeywords = ['tarih', 'karar tarihi', 'duruşma tarihi'];
  for (const kw of generalKeywords) {
    const idx = lower.indexOf(kw);
    if (idx !== -1) {
      const window = text.slice(idx, idx + 80);
      dateRegex.lastIndex = 0;
      const match = dateRegex.exec(window);
      if (match) {
        const d = match[1].padStart(2, '0');
        const m = match[2].padStart(2, '0');
        return `${d}.${m}.${match[3]}`;
      }
    }
  }

  return null;
}

const FULL_UYAP_PATTERN = /^(\d{4})[_\s](\d{1,7})[_\s](.+?)(?:[_\s](\d{2})[_\s](\d{2})[_\s](\d{4}))?(?:[_\s]\((\d+)[_\s]?ek\))?$/i;

function extractUyapFilenameEvidence(filenameWithoutExt: string): {
  case_number?: string;
  case_kind?: CaseKind;
  document_type?: string;
  document_date?: string;
} {
  const match = filenameWithoutExt.match(FULL_UYAP_PATTERN);
  if (!match) return {};

  const year = parseInt(match[1], 10);
  const sequence = parseInt(match[2], 10);
  if (year < 1980 || year > 2100 || sequence <= 0) return {};

  const case_number = `${year}/${sequence}`;
  const rawType = match[3].replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  
  // Map to canonical type if known
  let document_type = rawType;
  const normalizedRaw = normalizeRawTypeKey(rawType);
  const foundRule = DEFAULT_DOCUMENT_TYPE_RULES.find((r) => normalizeRawTypeKey(r.rawType) === normalizedRaw);
  if (foundRule) {
    document_type = foundRule.canonicalType;
  }

  let document_date: string | undefined;
  if (match[4] && match[5] && match[6]) {
    const day = match[4].padStart(2, '0');
    const month = match[5].padStart(2, '0');
    document_date = `${day}.${month}.${match[6]}`;
  }

  return {
    case_number,
    case_kind: 'ESAS',
    document_type,
    document_date
  };
}

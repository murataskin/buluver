import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentParser } from '../src/services/doc-parser.js';

describe('DocumentParser Legal Heuristics', () => {
  test('extracts court name and normalizes abbreviations', () => {
    const text = `
      T.C.
      İSTANBUL ANADOLU 15. AİLE MAHKEMESİ
      ESAS NO : 2024/780 Esas
      DAVACI  : Ayşe Yılmaz
      DAVALI  : Mehmet Yılmaz
      DAVA DİLEKÇESİDİR
    `;
    const meta = DocumentParser.extractMetadataHeuristics(text, 'belge.docx');
    assert.ok(meta.court_name);
    assert.match(meta.court_name, /AİLE MAHKEMESİ/i);
    assert.equal(meta.case_kind, 'ESAS');
    assert.equal(meta.case_number, '2024/780');
    assert.equal(meta.document_type, 'Dava Dilekçesi');
  });

  test('extracts Sigorta Tahkim Komisyonu and arbitration docket format', () => {
    const text = `
      SİGORTA TAHKİM KOMİSYONU BAŞKANLIĞINA
      BAŞVURU NO: 2025.E.726196
      BAŞVURU SAHİBİ: Can Demir (TCKN: 12345678901)
      SİGORTA KURULUŞU: Güven Sigorta A.Ş.
      KONU: Hasar tazminatı talebidir.
    `;
    const meta = DocumentParser.extractMetadataHeuristics(text, 'arbitration.pdf');
    assert.ok(meta.court_name);
    assert.match(meta.court_name, /SİGORTA TAHKİM KOMİSYONU/i);
    assert.equal(meta.case_kind, 'BASVURU');
    assert.equal(meta.case_number, '2025/726196');
    assert.equal(meta.plaintiff, 'Can Demir');
    assert.equal(meta.defendant, 'Güven Sigorta A.Ş.');
  });

  test('extracts prosecution (soruşturma) dockets without confusing with esas', () => {
    const text = `
      T.C.
      İSTANBUL CUMHURİYET BAŞSAVCILIĞI
      SORUŞTURMA NO : 2024/45678
      ŞİKAYETÇİ : Ali Vural (VKN: 9876543210)
      ŞÜPHELİ   : Veli Kaya
      KOVUŞTURMAYA YER OLMADIĞINA DAİR KARAR
      
      Gereği düşünüldü:
      Şüpheli hakkında kamu adına kovuşturmaya yer olmadığına karar verildi.
    `;
    const meta = DocumentParser.extractMetadataHeuristics(text, 'savcilik.udf');
    assert.ok(meta.court_name);
    assert.match(meta.court_name, /CUMHURİYET BAŞSAVCILIĞI/i);
    assert.equal(meta.case_kind, 'SORUSTURMA');
    assert.equal(meta.case_number, '2024/45678');
    assert.equal(meta.document_type, 'Takipsizlik Kararı');
    assert.equal(meta.plaintiff, 'Ali Vural');
    assert.equal(meta.defendant, 'Veli Kaya');
  });

  test('ignores precedent citations in body text and preserves real case number', () => {
    const text = `
      T.C.
      ANKARA 2. ASLİYE HUKUK MAHKEMESİ
      ESAS NO : 2023/105
      DAVACI  : Kemal Tekin
      DAVALI  : İnşaat Ltd. Şti.
      
      Yargıtay 11. Hukuk Dairesi'nin 2019/345 Esas sayılı ilamında da belirtildiği üzere...
      Davanın kabulü gerekir.
    `;
    const meta = DocumentParser.extractMetadataHeuristics(text, 'dilekce.docx');
    assert.equal(meta.case_number, '2023/105');
    assert.equal(meta.case_kind, 'ESAS');
    assert.notEqual(meta.case_number, '2019/345');
  });

  test('cleans TCKN, addresses, and corporate noise from party identities', () => {
    const text = `
      T.C. BAKIRKÖY 1. İŞ MAHKEMESİ
      ESAS : 2024/999
      DAVACI : Zeynep Aydın, T.C. Kimlik No: 11111111110, Adres: Kadıköy/İstanbul
      VEKİLİ : Av. Murat Can Aşkın
      DAVALI : Mega Lojistik Taşımacılık San. ve Tic. A.Ş. (Vergi No: 1234567890)
    `;
    const meta = DocumentParser.extractMetadataHeuristics(text, 'is_davasi.pdf');
    assert.equal(meta.plaintiff, 'Zeynep Aydın');
    assert.equal(meta.defendant, 'Mega Lojistik Taşımacılık San. ve Tic. A.Ş.');
  });

  test('infers document type structurally (Cevap Dilekçesi)', () => {
    const text = `
      T.C. İSTANBUL 5. ASLİYE TİCARET MAHKEMESİNE
      ESAS NO: 2024/500
      DAVALI VEKİLİ: Av. Mehmet Demir
      
      AÇIKLAMALAR:
      Davacı tarafın iddiaları haksız ve mesnetsizdir. Zamanaşımı itirazında bulunuyoruz.
      Davanın esastan reddini talep ederiz.
      Saygılarımla arz ve talep ederim.
    `;
    const meta = DocumentParser.extractMetadataHeuristics(text, 'evrak_123456.udf');
    assert.equal(meta.document_type, 'Cevap Dilekçesi');
  });

  test('extracts document date near proximity keywords', () => {
    const text = `
      T.C. İSTANBUL 3. ASLİYE HUKUK MAHKEMESİ
      ESAS NO: 2023/200
      GEREKÇELİ KARAR
      KARAR TARİHİ : 14/05/2024
      
      GEREĞİ DÜŞÜNÜLDÜ:
      HÜKÜM: Davanın kabulüne...
    `;
    const meta = DocumentParser.extractMetadataHeuristics(text, 'karar.docx');
    assert.equal(meta.document_type, 'Gerekçeli Karar');
    assert.equal(meta.document_date, '14.05.2024');
  });

  test('falls back to UYAP filename evidence when body text is sparse', () => {
    const filename = '2024_780_Bilirkişi Raporu_06_05_2024 (1 ek).pdf';
    const meta = DocumentParser.extractMetadataHeuristics('', filename);
    assert.equal(meta.case_number, '2024/780');
    assert.equal(meta.case_kind, 'ESAS');
    assert.equal(meta.document_type, 'Bilirkişi Raporu');
    assert.equal(meta.document_date, '06.05.2024');
  });
});

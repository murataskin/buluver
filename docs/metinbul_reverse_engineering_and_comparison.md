# MetinBul: Tersine Mühendislik, Mimari Analiz ve İzBul (Buluver) Karşılaştırması

> **Belge Sürümü:** 1.0.0  
> **Tarih:** 26 Eylül 2026  
> **İnceleme Konusu:** [raciyuksekbas-hub/metinbul-releases](https://github.com/raciyuksekbas-hub/metinbul-releases) (v0.1.0, v0.2.0, v0.2.1, v0.2.2-rc.1)  
> **Önceki Oturum Referansı:** AGY Session `0227c736-c00b-49d5-bc5a-a4018abd76f8` (31 Ağustos 2026)

---

## 1. Yönetici Özeti ve Arka Plan

**MetinBul**, meslektaşı hukukçular için Av. Raci Çetin Yüksekbaş tarafından yapay zekâ destekli ("vibe coding") olarak geliştirilen, yerel çalışan bir masaüstü belge arama aracıdır. Windows ve macOS üzerinde DOC, DOCX, PDF ve UDF formatındaki dosyaların dosya adı ve içeriklerinde tam metin araması (Full-Text Search) yapar.

### Temel Felsefesi ve Prensipleri:
1. **Local-First & Sıfır Telemetri:** Hiçbir kullanıcı verisi, belge içeriği veya arama sorgusu harici sunuculara aktarılmaz. Merkezi telemetri veya analitik bulunmaz.
2. **Kelimeden / İnfix Arama:** SQLite FTS5 `trigram` tokenizer kullanılarak sözcüğün ortasından geçen ifadeler dahi bulunabilir (ör. `gıtay` yazarak `Yargıtay` içeren belgeleri bulma).
3. **Masaüstü Entegrasyonu:** Minimalist Vanilla JS arayüzü, macOS Gatekeeper / Windows SmartScreen uyarılarına karşın yerel çalışabilir installer ve taşınabilir mimari.

---

## 2. MetinBul Sürüm Geçmişi ve Son Gelişmeler

| Sürüm | Yayın Tarihi | Öne Çıkan Değişiklikler | Dağıtım Varlıkları |
| :--- | :--- | :--- | :--- |
| **v0.1.0** | 23 Ağustos 2026 | İlk kararlı sürüm; DOC, DOCX, PDF, UDF desteği; FTS5 trigram arama motoru. | macOS DMG, Windows NSIS Setup |
| **v0.2.0** | 27 Ağustos 2026 | Özel snippet motoru, Arama Alanları (Include/Exclude), Google Drive FileProvider atlama. | macOS DMG, Windows NSIS Setup |
| **v0.2.1** | 29 Ağustos 2026 | UI/UX iyileştirmeleri, stabilite güncellemeleri, geliştirici mektubu ve ilkeler. | macOS DMG, Windows NSIS Setup |
| **v0.2.2-rc.1** | 31 Ağustos 2026 | **Windows OneDrive Hotfix (Ön Sürüm):** Windows 11 + OneDrive *Files On-Demand* ortamında placeholder dosyaların istemsizce indirilmesini önleyen kontrol. | Windows NSIS Setup (`v0.2.2`) |

---

## 3. Derinlemesine Tersine Mühendislik (Reverse Engineering)

MetinBul, Electron tabanlı derlenmiş olup `dist/main.js`, `dist/preload.cjs`, `dist/renderer/renderer.js` ve statik HTML/CSS varlıklarından oluşur. TypeScript kaynak kodları esbuild aracılığıyla doğrudan ES modüllerine ve CommonJS preload katmanına paketlenmiştir.

```
metinbul-releases/
├── package.json
├── dist/
│   ├── main.js                  # Electron Main Process, SQLite DB, Scanner, Extractor'lar
│   ├── preload.cjs              # Güvenli contextBridge API köprüsü
│   └── renderer/
│       ├── index.html           # Minimalist arayüz iskeleti
│       ├── renderer.js          # DOM etkileşimleri, debounce, tema yönetimi
│       └── style.css            # Dark/Light tema stilleri
├── .github/workflows/
│   └── build-windows.yml        # Windows CI/CD, NSIS paketleyici ve test koşucusu
└── assets/                      # Platform ikonları (.icns, .ico, .png)
```

---

### 3.1. Veritabanı ve Arama Mimarisi (`AppDatabase`)

* **Veritabanı Motoru:** `better-sqlite3` (v13.0.3)
* **Kalıcılık Yeri:** `%APPDATA%\MetinBul\metinbul.db` (Windows) veya `~/Library/Application Support/MetinBul/metinbul.db` (macOS).
* **SQLite Ayarları:**
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  ```

#### Tablo Şeması:
```sql
CREATE TABLE IF NOT EXISTS folders (
  path TEXT PRIMARY KEY NOT NULL,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_areas (
  path TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,           -- 'include' veya 'exclude'
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  extension TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  content TEXT NOT NULL,
  index_status TEXT NOT NULL,   -- 'indexed', 'no_text', 'failed'
  indexed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
CREATE INDEX IF NOT EXISTS idx_search_areas_type ON search_areas(type);

-- Sanal FTS5 Tablosu (Trigram Tokenizer)
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  filename,
  content,
  tokenize = 'trigram'
);
```

#### Otomatik FTS5 Şema Geçişi:
Uygulama açılışta `sqlite_master` üzerinden `documents_fts` SQL tanımını kontrol eder. Eğer mevcut tabloda `trigram` yer almıyorsa (eski sürümden kalma ise), tabloyu düşürüp (`DROP TABLE documents_fts`) mevcut belgeleri Türkçe normalizasyonundan geçirerek yeniden oluşturur ve doldurur.

---

### 3.2. Metin Normalizasyonu ve Trigram FTS Sorguları

MetinBul, Türkçe karakter duyarlılığını sağlamak için tüm indeksleme ve arama safhalarında tekil bir normalizasyon fonksiyonu kullanır:

```javascript
function normalizeForSearch(text) {
  if (!text) return "";
  return text.normalize("NFC").toLocaleLowerCase("tr-TR");
}
```

* **FTS5 Trigram Sınırlaması:** SQLite Trigram tokenizer'ı 3 karakterden kısa terimlerde çalışmaz.
* **Sorgu İnşası:**
  ```javascript
  function buildFtsQuery(userQuery) {
    if (!userQuery || !userQuery.trim()) return null;
    const normalized = normalizeForSearch(userQuery);
    const clean = normalized.replace(/[\"']/g, " ").replace(/\s+/g, " ").trim();
    if (clean.length < 3) return null;
    return `"${clean}"`; // Tam ifade olarak trigram eşleşmesi
  }
  ```
* **Sorgu Çalıştırma:**
  ```sql
  SELECT d.id, d.path, d.filename, d.extension, d.content, d.index_status
  FROM documents_fts
  JOIN documents d ON d.id = documents_fts.rowid
  WHERE documents_fts MATCH ?
  ORDER BY rank
  LIMIT 1000;
  ```

---

### 3.3. Belge Çıkarıcıları (Extractors)

Desteklenen uzantılar: `.doc`, `.docx`, `.pdf`, `.udf`

1. **`.docx` (Microsoft Word):**
   * Kütüphane: `mammoth` (v1.11.0)
   * Yöntem: `mammoth.extractRawText({ path: filePath })`
2. **`.pdf` (Adobe PDF):**
   * Kütüphane: `pdf-parse` (v2.4.5)
   * Buffer üzerinden okunur; çoklu sayfa dizileri satır satır birleştirilir.
   * **Sınırlama:** OCR motoru bulunmamaktadır. Taranmış resim PDF'leri metin katmanı içermediğinden indekslenemez.
3. **`.doc` (Eski Word İkili Formatı):**
   * Kütüphane: `word-extractor` (v1.0.4)
   * Yöntem: `extractor.extract(filePath)` -> `body.trim()`
4. **`.udf` (UYAP Doküman Formatı):**
   * Kütüphaneler: `adm-zip` (v0.5.16) + `fast-xml-parser` (v5.4.1)
   * **Çıkarma Mantığı:**
     * ZIP arşivi açılır ve `content.xml` (veya `.xml` ile biten dosya) aranır.
     * Eğer dosya bir ZIP değilse, doğrudan düz metin XML olup olmadığı kontrol edilir (`rawContent.trim().startsWith("<")`).
     * `fast-xml-parser` ile XML AST oluşturulur.
     * `collectTextFromXmlObject` fonksiyonu özyinelemeli (recursive) olarak tüm düğümleri dolaşır; XML nitelikleri (`@_` ile başlayanlar) atlanarak yalnızca metin içerikleri toplanıp boşlukla birleştirilir.

---

### 3.4. Dizin Tarayıcısı ve Bulut Placeholder Koruması

#### Arama Kökleri Keşfi (`roots.ts`):
* `os.homedir()` (Kullanıcı Ana Dizini)
* **macOS Cloud Alanları:**
  * `~/Library/Mobile Documents/com~apple~CloudDocs` (iCloud Drive)
  * `~/Library/CloudStorage/*` (Google Drive Desktop, OneDrive)
  * `/Volumes/*` (Harici USB bellekler, harici HDD/SSD; kök dosya sistemi `/` filtrelenerek eklenir)

#### macOS `SF_DATALESS` Koruması:
macOS FileProvider ve bulut sürücülerinde (iCloud, Google Drive, OneDrive) yalnızca bulutta bulunan dosyaların yerel dosya sistemi üzerinde boş "placeholder" kayıtları bulunur. Bu dosyalar normal bir dosya okuma isteği (`fs.readFile`) aldığında macOS işletim sistemi dosyayı arka planda internetten indirmeye başlar.

MetinBul, bunu önlemek için macOS sistem çağrısını 200'lük gruplar halinde toplu çalıştırır:
```javascript
// /usr/bin/stat -L -f "%@:%#Xf" -- [dosya yolları...]
const SF_DATALESS = 0x40000000; // 1073741824

function isDatalessPlaceholder(stats, fallbackFlags) {
  const flags = stats?.flags ?? fallbackFlags;
  return typeof flags === "number" && (flags & SF_DATALESS) !== 0;
}
```
Eğer dosya `SF_DATALESS` bayrağına sahipse, tarayıcı dosyayı atlar ve diskte yer kaplamayan dosyaların istemsizce indirilmesini engeller.

#### Windows OneDrive Durumu (v0.2.2-rc.1):
v0.2.1'de Windows üzerinde OneDrive Files On-Demand açıkken benzer bir koruma bulunmadığından Windows işletim sistemi "Otomatik dosya indirmeleri" bildirimi veriyordu. v0.2.2-rc.1 ile Windows API dosya öznitelikleri (`FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` / `FILE_ATTRIBUTE_OFFLINE`) seviyesinde bir denetim eklenmiştir.

---

### 3.5. Özel Snippet (Önizleme) Motoru

MetinBul, SQLite'ın standart `snippet()` fonksiyonunu kullanmak yerine JavaScript tarafında çalışan özel bir metin kırpma algoritması (`generateCustomSnippet`) kullanır:

* **Bütçe:** 180 karakter.
* **Konumlandırma Dağılımı:** Eşleşmenin soluna bütçenin %45'i, sağına ise kalanı (%55) ayrılır.
* **Kelime Sınırı Koruması:** Kırpma noktaları en yakın boşluk karakterine (`indexOf(" ", start)`) yuvarlanarak kelimelerin ortadan bölünmesi önlenir.
* **Vurgulama:** Eşleşen metin `<mark>...</mark>` etiketleriyle sarılır; metin başı ve sonuna gerektiğinde `…` (üç nokta) eklenir.

---

### 3.6. CI/CD ve Dağıtım Pipeline'ı (`build-windows.yml`)

GitHub Actions üzerinde Windows x64 paketleme mimarisi oldukça özenle kurgulanmıştır:
1. `npm ci` ile bağımlılıklar kurulur.
2. `electron-builder --win --x64` ile NSIS kurulum paketi ve unpacked yürütülebilir dosya üretilir.
3. **Otomatik Duman Testleri (Smoke Tests):**
   * `win-unpacked/MetinBul.exe` çalıştırılır (`--no-sandbox --disable-gpu`), 8 saniye sonra sağlıklı PID ve bellek yanıtı doğrulanır, kapatılır.
   * `MetinBul-Setup-*.exe` sessiz modda (`/S`) kurulur, Masaüstü ve Başlat Menüsü `.lnk` kısayolları test edilir, kurulu program çalıştırılır, ardından sessiz uninstaller çalıştırılarak sistemin temizlendiği doğrulanır.
4. **Büyük Dosya Dağıtımı:** GitHub'ın dosya boyutu limitlerini aşmamak adına `50MB`'lık parçalara (`.part1`, `.part2`...) bölünerek `windows-binary-deliverable` isimli yetim (orphan) bir git dalına yüklenir.

---

## 4. Karşılaştırma Matrisi: MetinBul vs. İzBul (Buluver)

| Boyut / Özellik | **MetinBul** | **İzBul / Buluver** |
| :--- | :--- | :--- |
| **Geliştirici & Konumlandırma** | Av. Raci Çetin Yüksekbaş (Masaüstü Kullanıcı Odaklı) | Murat Can Aşkın (Gelişmiş Hukuk Arama + AI Agent Altyapısı) |
| **Arayüz (UI) Katmanı** | Vanilla JS + HTML5/CSS3 (Hafif, bağımlılıksız) | React 19 + TailwindCSS v4 + Vite + Lucide Icons |
| **Desteklenen Dosya Formatları** | `.doc`, `.docx`, `.pdf`, `.udf` | `.udf` (Birincil) + Geliştirilebilir çoklu format |
| **FTS Tokenizer & Eşleşme Mantığı** | **FTS5 `trigram`**<br>• Doğrudan infix/substring eşleşmesi<br>• En az 3 karakter gereksinimi | **FTS5 `unicode61 remove_diacritics 2`**<br>• Gelişmiş Boolean operatörler (`AND`, `OR`, `NOT`, `-`, `*`) |
| **Semantik & Vektör Arama** | ❌ Yok (Yalnızca metin anahtar kelime araması) | ✅ **Yerel Transformers** (`@huggingface/transformers` MiniLM) + Cosine Similarty + Hibrit RRF Sıralama |
| **Yapay Zekâ ile Belge Analizi** | ❌ Yok | ✅ **Multi-Provider LLM Entegrasyonu** (Ollama, OpenAI, Gemini) ile otomatik özet, etiket ve karar künyesi |
| **Ajan Protokolü (MCP)** | ❌ Yok | ✅ **Yerleşik FastMCP Sunucusu** (Claude Desktop, Cursor, Zed ve AI agent'lar için doğrudan araç seti) |
| **Dosya Sistemi İzleme (Watcher)** | ❌ Yok (Yalnızca açılışta veya elle tam tarama) | ✅ **`chokidar` Gerçek Zamanlı İzleyici** (Dosya eklendiğinde/silindiğinde anında artımlı indeksleme) |
| **İndeksleme İş Parçacığı** | Ana süreçte senkron / asenkron tek kanal | **`worker_threads` İşçi Havuzu** (Çok çekirdekli paralel metin çıkarma) |
| **Dataless Bulut Dosya Koruması** | ✅ macOS `stat` `SF_DATALESS` denetimi + Windows OneDrive kontrolü | ⚠️ Standart dosya sistemi denetimi |
| **Arama Kapsamı Yönetimi** | Sistem geneli otomatik kök keşfi + Include/Exclude arayüzü | Kullanıcı tarafından kaydedilen klasör listesi |

---

## 5. İzBul İçin MetinBul'dan Alınabilecek Yüksek Değerli Dersler

MetinBul'un tersine mühendisliği, İzBul'un mimarisine entegre edilebilecek şu pratik kazanımları ortaya koymaktadır:

1. **macOS `SF_DATALESS` ve Windows Placeholder Koruması:**
   * Birçok hukuk bürosu dosyalarını Google Drive Desktop, OneDrive veya iCloud Drive üzerinde tutar.
   * İzBul'a MetinBul'un 200'lük gruplar halinde çalışan `/usr/bin/stat -L -f "%@:%#Xf"` kontrolü eklenmelidir. Bu sayede yalnızca çevrim içi olan (cihazda yer kaplamayan) dosyaların taranması sırasında bant genişliği tüketilmesi ve uygulamanın donması engellenir.
2. **Çoklu Belge Formatı Çıkarıcıları (Multi-Format Support):**
   * MetinBul'daki `mammoth` (DOCX), `word-extractor` (DOC) ve `pdf-parse` (PDF) kütüphaneleri İzBul'un `worker_threads` mimarisine aktarılarak İzBul yalnızca bir UDF aracı olmaktan çıkarılıp eksiksiz bir "Hukuk Bürosu Arama Motoru" haline getirilebilir.
3. **Çift Modlu Arama (Boolean vs. Trigram/Infix):**
   * İzBul'un güçlü Boolean arama motoruna ek olarak, dosya esas numarası, karar numarası veya kök kelime parçalarıyla arama yapmak isteyen kullanıcılar için ikincil bir "İnfix / Parça Arama (Trigram)" modu eklenebilir.
4. **Hızlı Arama (Quick Search Window):**
   * MetinBul'un `Option + Space` / `Ctrl + Shift + M` ile sistem genelinden çağrılabilen kompakt arama kutusu, günlük avukatlık pratiğinde Spotlight / Raycast benzeri hızlı bir erişim sağlar.

---

## 6. Sonuç

MetinBul, modern bir hukukçunun kendi mesleki ihtiyaçları doğrultusunda yapay zekâ ile ürettiği son derece temiz, amaca yönelik ve kullanıcı gizliliğini en üst düzeyde tutan başarılı bir yerel masaüstü aracıdır. İzBul (Buluver) ise semantik vektör araması, LLM ile zenginleştirme ve MCP (Model Context Protocol) sunucusu özellikleriyle yapay zekâ ajanları çağına hitap eden daha derinlikli bir platformdur. 

MetinBul'un bulut dosya koruma mekanizmaları ve çoklu format çıkarıcıları İzBul'a kazandırıldığında, İzBul masaüstü kararlılığı ve dosya desteği açısından mükemmel bir seviyeye ulaşacaktır.

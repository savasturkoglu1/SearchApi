# SearchApi → FlightScanner adapter entegrasyon sözleşmesi

Bu doküman, bu repodaki browser-backed arama API'sini
`/Users/savasturkoglu/AI/FlightScanner/src/adapters` altında yeni bir provider olarak
bağlayacak agent için uygulama sözleşmesidir.

Dokümandaki davranışlar 5 Ağustos 2026 tarihindeki SearchApi kodu ve contract
testleri esas alınarak yazılmıştır. API henüz internete açık bir üçüncü taraf servis
değildir; SearchApi process'inin FlightScanner tarafından erişilebilir olması gerekir.

## 1. En kısa implementasyon özeti

FlightScanner tarafında şu dosyaların oluşturulması/değiştirilmesi önerilir:

1. `src/adapters/browser-search-api.client.ts`
   - Base URL, Bearer token, timeout, JSON parse ve HTTP hata sınıflandırmasını tek
     yerde toplar.
2. `src/adapters/browser-google-flights.ts`
   - `FlightSourceAdapter` uygular.
   - Tek yön uçuşlarda arama → booking; gidiş-dönüşte arama → dönüş → booking
     zincirini yürütür.
3. `src/adapters/browser-google-stays.ts`
   - `StaySourceAdapter` uygular.
   - `hotels` ve `vacation_rentals` isteklerini ayrı endpoint'lere yollar;
     `propertyType: "any"` için iki sonucu birleştirir.
4. `src/adapters/types.ts`
   - Booking response tipleri gerekiyorsa aşağıdaki ek tiplerle genişletilir.
5. `src/adapters/hotel-types.ts`
   - `NormalizedStay.priceIsEstimated?: boolean`
   - `StaySearchResult.priceInsights?: PriceInsights`
6. `src/config.ts` ve `.env.example`
   - `BROWSER_SEARCH_API_BASE_URL`
   - `BROWSER_SEARCH_API_TOKEN`
   - isteğe bağlı `BROWSER_SEARCH_MARKET_PROFILE`
7. Adapter unit/contract testleri
   - HTTP fixture'larıyla tek yön, gidiş-dönüş, booking, otel, kiralık yer,
     `propertyType:any`, auth ve token-expiry senaryolarını kapsar.

Temel uçuş ve konaklama response alanları zaten FlightScanner'daki
`types.ts`/`hotel-types.ts` yapısıyla aynı isimleri kullanır. Provider JSON'unu yeniden
normalize etmeye gerek yoktur; doğrulayıp, desteklenmeyen query filtrelerini uygulayıp
ve booking bilgisini seçilen teklife eklemek yeterlidir.

## 2. Bağlantı ve kimlik doğrulama

Varsayılan lokal adres:

```text
http://127.0.0.1:3045
```

`GET /health` dışında bütün route'lar token ister. İki header biçimi desteklenir;
adapter için Bearer kullanılması önerilir:

```http
Authorization: Bearer <API_TOKEN>
Accept: application/json
Content-Type: application/json
```

Alternatif:

```http
x-api-token: <API_TOKEN>
```

Önerilen FlightScanner env değerleri:

```dotenv
BROWSER_SEARCH_API_BASE_URL=http://127.0.0.1:3045
BROWSER_SEARCH_API_TOKEN=replace-with-the-same-long-token
BROWSER_SEARCH_MARKET_PROFILE=TR-IST
BROWSER_SEARCH_API_TIMEOUT_MS=120000
```

SearchApi'nin kendi `.env` dosyasındaki `API_TOKEN` en az 16 karakter olmalıdır.

## 3. Market profilleri

İstemci `currency`, `country`, `language` ve timezone'u ayrı ayrı göndermez. Bunların
yerine her otomatik arama isteğinde aşağıdaki `marketProfile` değerlerinden biri
gönderilir:

| ID | Locale | Timezone | Ülke | Response para birimi |
|---|---|---|---|---|
| `TR-IST` | `tr-TR` | `Europe/Istanbul` | `TR` | `TRY` |
| `DE-FRA` | `de-DE` | `Europe/Berlin` | `DE` | `EUR` |
| `FR-PAR` | `fr-FR` | `Europe/Paris` | `FR` | `EUR` |
| `GB-LON` | `en-GB` | `Europe/London` | `GB` | `GBP` |
| `US-NYC` | `en-US` | `America/New_York` | `US` | `USD` |
| `US-SFO` | `en-US` | `America/Los_Angeles` | `US` | `USD` |

Önemli kurallar:

- SearchApi para birimini market profilinden üretir. FlightScanner query'sindeki
  `currency` ile market para birimi farklıysa adapter isteği sessizce dönüştürmemeli;
  `invalid_query` dönmeli veya uygulamanın açıkça tanımladığı döviz dönüşüm katmanına
  bırakmalıdır.
- EUR tek başına `DE-FRA`/`FR-PAR`, USD de `US-NYC`/`US-SFO` ayrımını yapamaz.
  En güvenlisi market profilini kullanıcı/konuşma bağlamında açıkça taşımaktır.
- Geçici uyumluluk için locale eşlemesi yapılabilir: `tr* → TR-IST`, `de* → DE-FRA`,
  `fr* → FR-PAR`, `en-GB → GB-LON`, `en-US → konfigüre edilmiş US default`.
- Her market kendi seri kuyruğunda çalışır. Aynı markete paralel gönderilen çağrılar
  SearchApi içinde sıraya girer; farklı marketler paralel çalışabilir.
- Profiller şu an aynı public IP'yi kullanır. Locale ve timezone IP ülkesini
  değiştirmez; bu nedenle üretim market fiyatı proxy eklenene kadar kesin değildir.

### `GET /v1/market-profiles`

Hazır browser ve kuyruk durumunu verir.

```json
{
  "profiles": [
    {
      "id": "TR-IST",
      "locale": "tr-TR",
      "timezoneId": "Europe/Istanbul",
      "language": "tr",
      "country": "TR",
      "currency": "TRY",
      "ready": true,
      "active": 0,
      "queued": 0,
      "browser": {
        "running": true,
        "engine": "patchright",
        "headless": false,
        "channel": "chrome",
        "openPages": 1,
        "sessionMode": "persistent"
      }
    }
  ]
}
```

Adapter startup'ında bu endpoint'i çağırmak zorunlu değildir. Readiness/operasyon
kontrolü olarak kullanılabilir.

## 4. Otomatik arama endpoint özeti

| Method | Path | Kullanım |
|---|---|---|
| `GET` | `/health` | Auth gerektirmeyen process ve market health bilgisi |
| `GET` | `/v1/market-profiles` | Market readiness ve kuyruk bilgisi |
| `GET` | `/v1/locations/flights` | Serbest metin/IATA için Google suggestion sonucu |
| `POST` | `/v1/search/web` | Normalize organik Google web sonuçları |
| `POST` | `/v1/search/flights` | Tek yön seçenekleri veya round-trip gidiş seçenekleri |
| `POST` | `/v1/search/flights/returns` | Seçilen gidişle uyumlu birleşik dönüş seçenekleri |
| `POST` | `/v1/search/flights/bookings` | Seçilen tam parkurun satıcı/link/bagaj/fiyat bilgisi |
| `POST` | `/v1/search/hotels` | Yalnız otel ve pansiyon |
| `POST` | `/v1/search/vacation-rentals` | Yalnız ev, villa, apart ve daire |

## 5. Ortak HTTP hata sözleşmesi

Başarısız HTTP cevapları şu zarftadır:

```json
{
  "error": "request_error",
  "message": "Geçersiz arama isteği",
  "details": {
    "fieldErrors": {
      "returnDate": ["returnDate departureDate'ten önce olamaz"]
    }
  }
}
```

Sunucu/Google hatasında `error` değeri `internal_error` olabilir:

```json
{
  "error": "internal_error",
  "message": "Google web araması CAPTCHA veya trafik doğrulamasına takıldı"
}
```

Adapter hata eşlemesi:

| HTTP/durum | `SourceError.code` | Davranış |
|---|---|---|
| `400` | `invalid_query` | Retry etme; server `message` değerini koru |
| `401` | `auth` | Retry etme; token/config hatası |
| `409` | `unavailable` | Browser state/capacity; kısa kontrollü retry yapılabilir |
| `502` | `unavailable` | Google/CAPTCHA/RPC sorunu; agresif retry yapma |
| `500`, `503`, network, timeout | `unavailable` | En fazla bir jitter'lı retry; sonra hatayı normalize et |
| JSON contract bozukluğu | `unknown` | Response'u logla ancak token/header loglama |

Search endpoint'leri HTTP seviyesinde başarılıysa `errors: []` döndürür. Mevcut
implementasyon normalize edilebilir hiç sonuç bulamazsa çoğunlukla boş başarılı liste
yerine `502` verir. Bu nedenle `502` "uçuş yok" olarak gösterilmemelidir.

## 6. Lokasyon suggestion

### Request

```http
GET /v1/locations/flights?q=Amsterdam&marketProfile=TR-IST
```

Kurallar:

- `q`: zorunlu, trim sonrası 1–120 karakter.
- `marketProfile`: zorunlu enum.
- Şehir/IATA tablosu tutmak zorunlu değildir. Ana uçuş endpoint'i de lokasyonu
  kendi içinde çözer; suggestion UI veya doğrulama için sunulmuştur.

### Response

```json
{
  "suggestions": [
    {
      "entityId": "/m/0k3p",
      "label": "Amsterdam, Hollanda",
      "name": "Amsterdam",
      "description": "Hollanda",
      "type": "city",
      "code": "AMS"
    },
    {
      "entityId": "/m/0v7w9",
      "label": "Amsterdam Schiphol Havalimanı (AMS)",
      "name": "Amsterdam Schiphol Havalimanı",
      "type": "airport",
      "code": "AMS",
      "parentEntityId": "/m/0k3p"
    }
  ]
}
```

`description`, `code` ve `parentEntityId` opsiyoneldir. `origin`/`destination`
alanlarına IATA (`IST`), şehir adı (`İstanbul`) veya biliniyorsa `entityId`
gönderilebilir.

## 7. Uçuş API'si

### 7.1 İlk arama — `POST /v1/search/flights`

Request:

```json
{
  "origin": "IST",
  "destination": "AMS",
  "departureDate": "2026-09-15",
  "returnDate": "2026-09-19",
  "adults": 3,
  "children": 2,
  "cabin": "economy",
  "marketProfile": "TR-IST"
}
```

| Alan | Zorunlu | Kural/default |
|---|---|---|
| `origin` | evet | 2–120 karakter; IATA, şehir adı veya Google entity ID |
| `destination` | evet | 2–120 karakter |
| `departureDate` | evet | `YYYY-MM-DD` |
| `returnDate` | hayır | Varsa departure ile aynı/sonraki gün |
| `adults` | hayır | default `1`, 1–9 |
| `children` | hayır | default `0`, 0–9; burada 2–11 yaş çocuk sayısıdır |
| `cabin` | hayır | default ve MVP'de kabul edilen tek değer `economy` |
| `marketProfile` | evet | desteklenen market enum'u |

`adults + children <= 9` olmalıdır. Infant ve çocuk yaşları bu API sürümünde
desteklenmez. Google'ın rezervasyon ufku dışındaki tarihler hata/sonuçsuz response
üretebilir.

Response `SearchResult`:

```ts
interface FlightSearchResult {
  query: FlightSearchQuery;
  offers: NormalizedOffer[];
  priceInsights?: PriceInsights;
  searchUrl?: string;
  errors: SourceError[];
}

interface NormalizedOffer {
  source: "google_flights_browser" | string;
  sourceOfferId?: string;
  outboundSegments: FlightSegment[];
  returnSegments: FlightSegment[];
  layovers: Layover[];
  totalDurationMinutes: number;
  stops: number;
  totalPrice: number;
  currency: string;
  baggageNotes?: string[];
  notes?: string[];
  priceIsEstimated?: boolean;
  bookingUrl?: string;
  retrievedAt: string;
  raw?: unknown;
}

interface FlightSegment {
  airlineName: string;
  flightNumber: string;
  departureAirport: string;
  departureTime: string;
  arrivalAirport: string;
  arrivalTime: string;
  durationMinutes: number;
  cabinClass?: string;
}

interface Layover {
  airport: string;
  durationMinutes: number;
  overnight?: boolean;
}

interface PriceInsights {
  lowestPrice?: number;
  priceLevel?: string;
  typicalPriceRange?: [number, number];
}
```

Round-trip ilk response'undaki tekliflerin anlamı:

- `outboundSegments` doludur, `returnSegments` boştur.
- `totalPrice`, bu gidişle uyumlu bir dönüş dahil Google'ın o aşamada gösterdiği
  gidiş-dönüş toplamıdır.
- Tam dönüş bacağı ve nihai satın alma linki için akış devam ettirilmelidir.
- `sourceOfferId`, `/returns` çağrısında kullanılacak opaque token'dır; parse veya
  değiştirilmemelidir.

Tek yön ilk response'unda teklif tamamlanmıştır. Satın alma linki ve bagaj koşulu
için aynı teklifin `sourceOfferId` değeri doğrudan `/bookings` endpoint'ine gönderilir.

### 7.2 Dönüş seçenekleri — `POST /v1/search/flights/returns`

Yalnız `returnDate` ile başlatılmış aramalarda çağrılır.

```json
{
  "offerId": "<ilk-response-sourceOfferId>",
  "marketProfile": "TR-IST"
}
```

Response yine `FlightSearchResult` biçimindedir. Farkı:

- Her offer içinde hem `outboundSegments` hem `returnSegments` doludur.
- `sourceOfferId`, artık tam gidiş+dönüş seçiminin booking token'ıdır.
- `totalPrice`, seçilen iki bacağın o anda gösterilen toplam fiyatıdır.
- Bir sonraki `/bookings` çağrısında bu response'taki token kullanılmalıdır.

### 7.3 Booking — `POST /v1/search/flights/bookings`

Round-trip için `/returns` sonucundaki, one-way için ilk arama sonucundaki
`sourceOfferId` gönderilir:

```json
{
  "offerId": "<final-sourceOfferId>",
  "marketProfile": "TR-IST"
}
```

Response:

```ts
interface FlightBookingResult {
  offerId: string;
  bookingOptions: FlightBookingOption[];
  bookingUrl?: string;
  baggageNotes?: string[];
  priceIsEstimated: boolean;
  priceInsights?: PriceInsights;
  searchUrl?: string;
  errors: SourceError[];
}

interface FlightBookingOption {
  sourceOptionId: string;
  seller: string;
  totalPrice: number;
  currency: string;
  bookingUrl?: string;
  bookingLinks?: FlightBookingLink[];
  baggageNotes?: string[];
}

interface FlightBookingLink {
  seller: string;
  totalPrice: number;
  bookingUrl: string;
}
```

Tek satıcı örneği:

```json
{
  "sourceOptionId": "opaque-booking-token",
  "seller": "Gotogate",
  "totalPrice": 40071,
  "currency": "TRY",
  "bookingUrl": "https://www.google.com/travel/clk/f?..."
}
```

Ayrı bilet örneği:

```json
{
  "sourceOptionId": "opaque-booking-token",
  "seller": "Pegasus + AJet",
  "totalPrice": 34213,
  "currency": "TRY",
  "bookingLinks": [
    {
      "seller": "Pegasus",
      "totalPrice": 16122,
      "bookingUrl": "https://www.google.com/travel/clk/f?..."
    },
    {
      "seller": "AJet",
      "totalPrice": 18091,
      "bookingUrl": "https://www.google.com/travel/clk/f?..."
    }
  ],
  "baggageNotes": [
    "Pegasus bagaj koşulları: https://...",
    "AJet bagaj koşulları: https://..."
  ]
}
```

Kurallar:

- Üst seviye `bookingUrl`, bütün parkuru tek bağlantıyla satın aldırabilen tercih
  edilen seçeneğin linkidir. Hiçbir seçenek tek link sunmuyorsa olmayabilir.
- Split-ticket seçeneği tek link gibi gösterilmemeli; `bookingLinks` korunmalıdır.
- `baggageNotes` şu anda tarife özel kg/adet garantisi değildir. Parkurdaki
  taşıyıcıların resmi bagaj politikası linklerini içerir.
- Booking aşamasındaki `priceInsights` ilk liste fiyatından daha zengindir ve
  `priceLevel`/`typicalPriceRange` içerebilir.

### 7.4 Uçuş seçim token'ı yaşam döngüsü

`sourceOfferId`:

- opaque'dir ve loglarda tam olarak yazılmaması tercih edilir;
- SearchApi memory'sinde 30 dakika tutulur;
- üretildiği **aynı `marketProfile`** ile kullanılmalıdır;
- üretildiği **aynı SearchApi process'ine** gitmelidir;
- server restartında kaybolur;
- çok instance'lı deploy'da sticky routing veya ortak seçim deposu gerektirir.

Token süresi dolduğunda `/returns` veya `/bookings` `502` döndürür. Adapter bunu
aynı token ile tekrar tekrar denememeli; gerekiyorsa zinciri ilk aramadan yeniden
başlatmalıdır.

### 7.5 FlightScanner `FlightSourceAdapter` için önerilen akış

Mevcut `FlightSourceAdapter.search()` tek bir `SearchResult` döndürdüğü için provider
zinciri adapter içinde tamamlanmalıdır.

Tek yön:

```text
/search/flights
  → en iyi N teklifi seç
  → her seçilen offer için /bookings
  → bookingUrl, baggageNotes ve güncel fiyatı NormalizedOffer'a ekle
```

Gidiş-dönüş:

```text
/search/flights
  → en iyi N gidişi seç
  → her gidiş için /returns
  → birleşik sonuçları fiyat/süre tercihlerine göre sırala
  → en iyi M birleşik sonuç için /bookings
  → bookingUrl, baggageNotes ve güncel fiyatı NormalizedOffer'a ekle
```

Maliyet/latency sınırı olarak varsayılan `N=3`, `M=5` önerilir. Aynı market kuyruğu
seri olduğu için yüksek `Promise.all` kullanımı gerçek paralellik sağlamaz ve CAPTCHA
riskini artırabilir.

Booking merge kuralı:

- `offer.bookingUrl = bookingResult.bookingUrl` (varsa)
- `offer.baggageNotes = bookingResult.baggageNotes` (varsa)
- `offer.priceIsEstimated = bookingResult.priceIsEstimated`
- `offer.totalPrice`, seçilen booking option fiyatıyla ancak aynı para birimindeyse
  güncellenebilir.
- Birden fazla/split-ticket satın alma adımını kaybetmemek için booking result ya
  yeni public tiplerle üst katmana taşınmalı ya da `offer.raw.booking` altında
  korunmalıdır. Müşteriye link üretilecekse yalnız `raw` içinde bırakmak yerine typed
  alan eklemek tercih edilir.

## 8. Konaklama API'si

### 8.1 Ortak request

`POST /v1/search/hotels` ve `POST /v1/search/vacation-rentals` aynı request gövdesini
kullanır:

```json
{
  "destination": "Amsterdam",
  "checkIn": "2026-10-03",
  "checkOut": "2026-10-06",
  "adults": 2,
  "rooms": 1,
  "children": 0,
  "includeImages": false,
  "marketProfile": "TR-IST"
}
```

| Alan | Zorunlu | Kural/default |
|---|---|---|
| `destination` | evet | 2–160 karakter |
| `checkIn` | evet | `YYYY-MM-DD` |
| `checkOut` | evet | check-in'den kesin olarak sonra |
| `adults` | hayır | default `2`, 1–30 |
| `rooms` | hayır | default `1`, 1–10 |
| `children` | hayır | default `0`, 0–20 |
| `includeImages` | hayır | default `false`; `true` ise tesis görsel URL'leri döner |
| `marketProfile` | evet | desteklenen market enum'u |

Endpoint ayrımı kesindir:

- `/search/hotels`: otel ve pansiyon;
- `/search/vacation-rentals`: kiralık ev, villa, apart ve daire.

### 8.2 Response

```ts
interface StaySearchResult {
  query: StaySearchQuery;
  stays: NormalizedStay[];
  priceInsights?: PriceInsights;
  searchUrl?: string;
  errors: SourceError[];
}

interface NormalizedStay {
  source: string;
  sourceStayId?: string;
  name: string;
  propertyType: string;
  hotelClass?: number;
  rating?: number;
  reviewCount?: number;
  locationRating?: number;
  gps?: { latitude: number; longitude: number };
  checkInTime?: string;
  checkOutTime?: string;
  ratePerNight?: number;
  totalPrice?: number;
  currency: string;
  otaPrices?: Array<{ seller: string; ratePerNight?: number }>;
  amenities?: string[];
  images?: string[];
  freeCancellation?: boolean;
  priceIsEstimated?: boolean;
  bookingUrl?: string;
  notes?: string[];
  retrievedAt: string;
  raw?: unknown;
}
```

`priceInsights.lowestPrice` konaklama sonuçlarında bulunan en düşük gecelik fiyattır.
`bookingUrl`, Google redirect/deep-link olabilir; istemci linki değiştirip yeniden
üretmemelidir.

`includeImages` gönderilmezse veya `false` ise `NormalizedStay.images` alanı response'tan
tamamen çıkarılır. Görseller ancak istemci gerçekten göstereceği zaman `true` gönderilerek
istenmelidir. FlightScanner adapter'ı query veya adapter option üzerinden aldığı bu değeri
hem hotel hem vacation-rental request body’sine aynı şekilde aktarmalıdır.

Bu değişikliği uygulayacak agent için kısa görev brief'i:
[`flightscanner-stay-images-adapter-brief.md`](flightscanner-stay-images-adapter-brief.md).

### 8.3 FlightScanner stay query eşlemesi

| FlightScanner alanı | SearchApi alanı/davranışı |
|---|---|
| `location` | `destination` |
| `checkInDate` | `checkIn` |
| `checkOutDate` | `checkOut` |
| `guests.adults` | `adults` |
| `guests.children` | `children` |
| `includeImages` | `includeImages`; varsayılan `false` |
| `propertyType: hotels` | `/search/hotels` |
| `propertyType: vacation_rentals` | `/search/vacation-rentals` |
| `propertyType: any` veya eksik | iki endpoint'i çağır, birleştir ve dedupe et |
| `currency`, `locale` | market profile seçimi/validasyonu |
| `childrenAges` | API yalnız çocuk sayısını destekler; yaşlar iletilmez |
| oda sayısı | FlightScanner query'de yok; adapter option/default `1` |
| yıldız/puan/fiyat/iptal filtreleri | server request'inde yok; response üstünde client-side uygula |
| `sortBy` | server request'inde yok; merge/filter sonrası client-side sırala |

`propertyType:any` birleştirmesinde önerilen dedupe anahtarı:

1. `sourceStayId` varsa `source + sourceStayId`;
2. yoksa normalize edilmiş `name + gps + ratePerNight`.

`freeCancellation: true` filtresinde alanı bilinmeyen (`undefined`) tesisleri kesin
ücretsiz iptal gibi kabul etmeyin. Katı filtre gerekiyorsa yalnız `true` olanları
tutun; sonuç sayısının azalacağını `errors`/`notes` ile belirtin.

FlightScanner hedef tipinde yapılması gereken minimum değişiklik:

```ts
// src/adapters/hotel-types.ts
import type { PriceInsights, SourceError } from "./types.js";

export interface NormalizedStay {
  // mevcut alanlar...
  priceIsEstimated?: boolean;
}

export interface StaySearchResult {
  query: StaySearchQuery;
  stays: NormalizedStay[];
  priceInsights?: PriceInsights;
  searchUrl?: string;
  errors: SourceError[];
}
```

## 9. Genel web araması

### `POST /v1/search/web`

Request:

```json
{
  "query": "varşova gezi planı",
  "limit": 10,
  "safeSearch": true,
  "marketProfile": "TR-IST"
}
```

Kurallar: `query` 1–500 karakter, `limit` default 10 ve 1–20, `safeSearch` default
`true`.

Response:

```ts
interface WebSearchResult {
  query: {
    text: string;
    language: string;
    country: string;
    safeSearch: boolean;
  };
  results: Array<{
    rank: number;
    title: string;
    url: string;
    displayUrl: string;
    description?: string;
  }>;
  searchUrl: string;
  retrievedAt: string;
  errors: SourceError[];
}
```

Yalnız organik sonuçlar döner; reklamlar ve Google iç navigasyon linkleri çıkarılır.
Bu endpoint mevcut `FlightSourceAdapter`/`StaySourceAdapter` arayüzüne konmamalı;
ayrı bir `WebSearchAdapter` veya agent tool'u olarak bağlanmalıdır.

## 10. Önerilen HTTP client iskeleti

```ts
type MarketProfileId =
  | "TR-IST"
  | "DE-FRA"
  | "FR-PAR"
  | "GB-LON"
  | "US-NYC"
  | "US-SFO";

interface BrowserSearchApiClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

class BrowserSearchApiClient {
  constructor(private readonly options: BrowserSearchApiClientOptions) {}

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await (this.options.fetchImpl ?? fetch)(
      new URL(path, this.options.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      },
    );

    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      // HTTP status + payload.message değerini SourceError'a sınıflandır.
      throw new BrowserSearchApiError(response.status, payload);
    }
    return payload as T;
  }
}
```

Güvenlik:

- Token'ı query string'e koymayın.
- Authorization header'ını, opaque `offerId` değerlerini ve booking redirect
  query'lerini application loglarına yazmayın.
- Error logunda request gövdesi gerekiyorsa token alanlarını maskeleyin.

## 11. Adapter interface boşlukları ve önerilen typed genişletme

Mevcut FlightScanner `NormalizedOffer` tek `bookingUrl` taşıyor fakat SearchApi
birden fazla satıcı ve split-ticket adımlarını döndürüyor. Bilgi kaybetmemek için
aşağıdaki tiplerin FlightScanner `types.ts` içine eklenmesi önerilir:

```ts
export interface FlightBookingLink {
  seller: string;
  totalPrice: number;
  bookingUrl: string;
}

export interface FlightBookingOption {
  sourceOptionId: string;
  seller: string;
  totalPrice: number;
  currency: string;
  bookingUrl?: string;
  bookingLinks?: FlightBookingLink[];
  baggageNotes?: string[];
}

export interface FlightBookingResult {
  offerId: string;
  bookingOptions: FlightBookingOption[];
  bookingUrl?: string;
  baggageNotes?: string[];
  priceIsEstimated: boolean;
  priceInsights?: PriceInsights;
  searchUrl?: string;
  errors: SourceError[];
}
```

`FlightSourceAdapter` geriye dönük uyumluluk için yalnız `search()` taşımaya devam
edebilir. Browser adapter'a özel gelişmiş bir interface istenirse:

```ts
export interface SelectableFlightSourceAdapter extends FlightSourceAdapter {
  searchReturns(offerId: string, marketProfile: MarketProfileId): Promise<SearchResult>;
  searchBookings(
    offerId: string,
    marketProfile: MarketProfileId,
  ): Promise<FlightBookingResult>;
}
```

AI akışının kullanıcının tek tek seçim yapmasını beklememesi halinde public tool yine
tek `search()` çağırır; adapter içeride top-N gidişleri genişletir. Ayrı metodlar
debug, ileri seviye seçim veya fiyat doğrulama için kullanılabilir.

## 12. Filtreleme ve normalize etme sorumluluğu

SearchApi MVP'nin server-side desteklemediği FlightScanner alanları:

- uçuş: `maxStops`, premium/business/first, infant tipleri, çoklu origin/destination;
- konaklama: çocuk yaşları, yıldız, minimum puan, ücretsiz iptal, fiyat aralığı,
  sıralama;
- konaklama room count FlightScanner query'sinde bulunmadığı için adapter default'u.

Önerilen davranış:

- Çoklu origin/destination için çapraz çarpımı sınırlı sayıda ayrı SearchApi çağrısı
  olarak çalıştır veya açık `invalid_query` dön. Sessizce yalnız ilk kodu almak yanlış.
- Economy dışı cabin için bu sürümde `invalid_query` dön.
- Infant varsa mevcut API ile doğru yolcu fiyatı üretilemeyeceği için `invalid_query`
  dön; yetişkine/çocuğa sessizce ekleme.
- `maxStops` filtresini normalize `stops` alanında client-side uygula.
- Stay filtrelerini normalize response üstünde uygula ve `sortBy` uygula.
- İstek para birimi ile market para birimi farklıysa sonucu istenen para birimi gibi
  etiketleme.

## 13. Operasyon ve retry kuralları

- SearchApi başlarken altı persistent market browser'ını sıcak tutar.
- Aynı repoda yalnız bir SearchApi dev watcher çalıştırılmalıdır.
- Aynı marketin istekleri seridir. FlightScanner flexible-search concurrency'si
  aynı market için latency'yi doğrusal artırabilir.
- CAPTCHA `502` üretir. Headful browser'da aynı market penceresinde manuel doğrulama
  tamamlandıktan sonra tekrar istek atılabilir.
- Arama ve booking fiyatları canlı ancak değişkendir; kullanıcıya verilmeden önce
  `retrievedAt` ve `priceIsEstimated` korunmalıdır.
- `bookingUrl` Google redirect URL'si olabilir ve zamanla geçersizleşebilir. Fiyat
  izleme kaydında saklanabilir fakat satın alma anında yeniden doğrulama önerilir.
- Otomatik retry sınırı en fazla bir deneme olmalı; CAPTCHA ve `400`/`401` retry
  edilmemelidir.
- Round-trip zinciri tek SearchApi instance + aynı market üzerinde tamamlanmalıdır.

## 14. Manuel browser/capture endpoint'leri

Bunlar FlightScanner provider adapter'ı için gerekli değildir; yeni Google RPC
araştırması ve hata ayıklama içindir.

| Method | Path | İşlev |
|---|---|---|
| `GET` | `/v1/browser` | Manuel BrowserPool durumu |
| `POST` | `/v1/browser/start` | Manuel pool'u hazırla |
| `POST` | `/v1/browser/stop` | Manuel context ve pool'u kapat |
| `GET` | `/v1/contexts` | Manuel context'leri listele |
| `POST` | `/v1/contexts` | Opsiyonel `{ "url": "https://..." }` ile context aç |
| `GET` | `/v1/contexts/:id` | Context/capture özeti |
| `POST` | `/v1/contexts/:id/navigate` | `{ "url": "https://..." }` ile ana page'i yönlendir |
| `DELETE` | `/v1/contexts/:id` | Context'i kapat ve capture yazılarını flush et |
| `GET` | `/v1/captures/:id` | In-memory capture özeti |

Capture dosyaları SearchApi içinde şu dizine yazılır:

```text
.api-capiture/YYYY-MM-DD/<context-id>/
├── session.json
├── index.ndjson
└── exchanges/*.json
```

## 15. Minimum acceptance test listesi

Adapter işi aşağıdaki testler geçmeden tamamlanmış sayılmamalıdır:

1. Bearer token her protected isteğe ekleniyor.
2. `401` → `SourceError.code = "auth"`.
3. `400` field errors → `invalid_query` ve server mesajı korunuyor.
4. One-way `/flights` sonucu `/bookings` ile zenginleştiriliyor.
5. Round-trip zinciri doğru token'larla flights → returns → bookings ilerliyor.
6. `/returns` ve `/bookings` ilk aramadaki market profilini koruyor.
7. Split-ticket `bookingLinks` kaybolmuyor.
8. `baggageNotes`, `bookingUrl`, `priceIsEstimated`, `priceInsights` korunuyor.
9. Hotels ve vacation rentals doğru endpoint'e yönleniyor.
10. `propertyType:any` iki listeyi çağırıyor, birleştiriyor ve dedupe ediyor.
11. Stay `priceInsights` ve `priceIsEstimated` hedef tipte korunuyor.
12. Currency/market uyuşmazlığı sessiz yanlış etiketleme üretmiyor.
13. Economy dışı cabin ve infant için açık desteklenmiyor hatası dönüyor.
14. Timeout/CAPTCHA'da boş başarılı sonuç yerine `unavailable` hatası dönüyor.
15. Token-expiry durumunda aynı stale token sonsuz retry edilmiyor.
16. Adapter loglarında Bearer token ve tam opaque offer token görünmüyor.

## 16. Hızlı canlı doğrulama

```bash
export BROWSER_CAPTURE_TOKEN='SearchApi .env içindeki API_TOKEN'

curl -sS http://127.0.0.1:3045/health

curl -sS http://127.0.0.1:3045/v1/market-profiles \
  -H "Authorization: Bearer $BROWSER_CAPTURE_TOKEN"

curl -sS -X POST http://127.0.0.1:3045/v1/search/flights \
  -H "Authorization: Bearer $BROWSER_CAPTURE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "origin":"IST",
    "destination":"AMS",
    "departureDate":"2026-09-15",
    "returnDate":"2026-09-19",
    "adults":1,
    "children":0,
    "cabin":"economy",
    "marketProfile":"TR-IST"
  }'

curl -sS -X POST http://127.0.0.1:3045/v1/search/hotels \
  -H "Authorization: Bearer $BROWSER_CAPTURE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "destination":"Amsterdam",
    "checkIn":"2026-10-03",
    "checkOut":"2026-10-06",
    "adults":2,
    "rooms":1,
    "children":0,
    "marketProfile":"TR-IST"
  }'
```

Not: Canlı Google sonucu, CAPTCHA ve 2026 rezervasyon ufku koşullarına bağlıdır.
Adapter unit testleri dış ağa/Google'a bağlı olmamalı; canlı smoke testi ayrı tutulmalıdır.

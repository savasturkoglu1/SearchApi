# Browser Capture Server MVP

Manuel tarayıcı işlemleri sırasında oluşan `xhr` ve `fetch` trafiğini yakalayan lokal browser server. Tarayıcı yaşam döngüsü Crawlee BrowserPool, browser sürücüsü seçime göre Playwright veya Patchright ile yönetilir.

## Ne yapar?

- Headful Chrome/Chromium context'i açar; işlemleri tarayıcı penceresinde manuel yaparsınız.
- Context seviyesinde tüm sekmelerin XHR/fetch istek ve yanıtlarını izler.
- Her exchange'i `.api-capiture/YYYY-MM-DD/<context-id>/` altına yazar.
- `/health` dışındaki route'ları Bearer token veya `x-api-token` ile korur.
- Patchright ve standart Playwright arasında env ile geçiş sağlar.
- Authorization, cookie, API key, token ve password benzeri alanları varsayılan olarak maskeler.
- Google Flights lokasyon suggestion RPC'sinden şehir entity ID'lerini dinamik çözer.
- Uçuş ve otel aramasını DOM'a tıklamadan Google Travel state URL'leri üzerinden çalıştırır.
- Yakalanan Google RPC cevaplarını normalize edilmiş uçuş ve otel sonuçlarına dönüştürür.

## Kurulum

```bash
npm install
cp .env.example .env
```

`.env` içindeki `API_TOKEN` değerini en az 16 karakterlik rastgele bir token ile değiştirin. Patchright için bilgisayarda Google Chrome yoksa:

```bash
npm run browser:install
```

Sunucuyu başlatın:

```bash
npm run dev
```

Varsayılan adres `http://127.0.0.1:3045` olur. `POST /v1/browser/start` havuzu hazırlar; görünür pencere ilk context oluşturulunca açılır.

## Manuel capture akışı

```bash
export BROWSER_CAPTURE_TOKEN='your-long-api-token'

curl -sS -X POST http://127.0.0.1:3045/v1/contexts \
  -H "Authorization: Bearer $BROWSER_CAPTURE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

Yanıttaki `id` açık browser context'inin kimliğidir. Tarayıcıda işlemleri manuel yapın; XHR/fetch cevapları otomatik yazılır.

Durum ve sayaç:

```bash
curl -sS http://127.0.0.1:3045/v1/contexts/<context-id> \
  -H "x-api-token: $BROWSER_CAPTURE_TOKEN"

curl -sS http://127.0.0.1:3045/v1/captures/<context-id> \
  -H "x-api-token: $BROWSER_CAPTURE_TOKEN"
```

Context'i kapatıp bekleyen yazma işlemlerini tamamlayın:

```bash
curl -sS -X DELETE http://127.0.0.1:3045/v1/contexts/<context-id> \
  -H "x-api-token: $BROWSER_CAPTURE_TOKEN"
```

## Otomatik arama API'si

Lokasyonlar için sabit bir IATA/şehir tablosu tutulmaz. Sunucu arama metnini Google Flights'ın `H028ib` suggestion çağrısıyla çözüp şehir entity ID'sini alır. Ardından `tfs`/`ts` form state'ini üretir, browser context içinde ilgili sayfayı açar, XHR/fetch cevabını yakalar ve normalize eder. Ana arama akışında DOM elementlerine tıklanmaz.

Lokasyon çözümlemeyi ayrı test etmek için:

```bash
curl -sS -G http://127.0.0.1:3045/v1/locations/flights \
  -H "Authorization: Bearer $BROWSER_CAPTURE_TOKEN" \
  --data-urlencode 'q=Amsterdam' \
  --data-urlencode 'currency=TRY' \
  --data-urlencode 'language=tr'
```

Uçuş araması:

```bash
curl -sS -X POST http://127.0.0.1:3045/v1/search/flights \
  -H "Authorization: Bearer $BROWSER_CAPTURE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "origin":"IST",
    "destination":"AMS",
    "departureDate":"2027-06-10",
    "returnDate":"2027-06-15",
    "adults":3,
    "children":2,
    "cabin":"economy",
    "currency":"TRY",
    "language":"tr"
  }'
```

Gidiş-dönüş aramasında ilk response'taki bir `sourceOfferId` ile dönüş seçeneklerini genişletme:

```bash
curl -sS -X POST http://127.0.0.1:3045/v1/search/flights/returns \
  -H "Authorization: Bearer $BROWSER_CAPTURE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"offerId":"<gidiş-sourceOfferId>"}'
```

Dönüş response'undaki bir `sourceOfferId` ile satın alma seçeneklerini alma:

```bash
curl -sS -X POST http://127.0.0.1:3045/v1/search/flights/bookings \
  -H "Authorization: Bearer $BROWSER_CAPTURE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"offerId":"<dönüş-sourceOfferId>"}'
```

Otel araması:

```bash
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
    "currency":"TRY",
    "language":"tr"
  }'
```

Kiralık yer araması otel aramasından ayrıdır; yalnız ev, villa, apart ve daire tipi sonuçları döndürür:

```bash
curl -sS -X POST http://127.0.0.1:3045/v1/search/vacation-rentals \
  -H "Authorization: Bearer $BROWSER_CAPTURE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "destination":"Kalkan",
    "checkIn":"2026-08-13",
    "checkOut":"2026-08-20",
    "adults":2,
    "rooms":1,
    "children":0,
    "currency":"TRY",
    "language":"tr"
  }'
```

`/v1/search/hotels` yalnız otel ve pansiyonları; `/v1/search/vacation-rentals` yalnız kiralık ev, villa, apart ve daireleri arar. İki kategori tek aramada birleştirilmez.

Uçuş route'u yetişkin ve 2–11 yaş çocuk sayılarını Google'ın yolcu state'ine ayrı tiplerle işler; toplam yolcu sayısı en fazla 9 olabilir. Tarihler Google Flights'ın görünür rezervasyon ufku içinde olmalıdır; bu aralık genellikle yaklaşık 330 gündür. Kabin state'i henüz ayrıca doğrulanmadığı için MVP yalnızca `economy` kabul eder. Otel route'unda yetişkin, oda ve çocuk sayısı state'e işlenir.

## Response sözleşmeleri

Temel arama alanları `FlightScanner/src/adapters/types.ts` ve `hotel-types.ts` sözleşmeleriyle uyumludur. SearchApi bunlara canlı fiyat durumu, fiyat içgörüleri ve satın alma bağlantıları gibi alanlar ekler. Request gövdesi bu sunucunun sade formatında kalır; istemci adapter'ı ek alanları koruyarak sonucu doğrudan normalize edebilir.

Uçuş response'u `SearchResult` biçimindedir:

```json
{
  "query": {
    "originAirports": ["Antalya"],
    "destinationAirports": ["Amsterdam"],
    "tripType": "round_trip",
    "departureDate": "2027-06-10",
    "returnDate": "2027-06-15",
    "passengers": {
      "adults": 3,
      "children": 2,
      "infantsInSeat": 0,
      "infantsOnLap": 0
    },
    "cabinClass": "economy",
    "currency": "TRY",
    "locale": "tr"
  },
  "offers": [
    {
      "source": "google_flights_browser",
      "sourceOfferId": "<google-selection-token>",
      "outboundSegments": [
        {
          "airlineName": "Turkish Airlines",
          "flightNumber": "TK 1951",
          "departureAirport": "AYT",
          "departureTime": "2027-06-10 08:30",
          "arrivalAirport": "AMS",
          "arrivalTime": "2027-06-10 11:20",
          "durationMinutes": 230,
          "cabinClass": "economy"
        }
      ],
      "returnSegments": [],
      "layovers": [],
      "totalDurationMinutes": 230,
      "stops": 0,
      "totalPrice": 52146,
      "currency": "TRY",
      "priceIsEstimated": false,
      "notes": [
        "Fiyat, bu gidiş seçeneğiyle uyumlu bir dönüş dahil Google'ın gösterdiği gidiş-dönüş toplamıdır; dönüş uçuşu detayları henüz genişletilmedi"
      ],
      "retrievedAt": "2026-08-04T12:00:00.000Z"
    }
  ],
  "priceInsights": { "lowestPrice": 52146 },
  "searchUrl": "https://www.google.com/travel/flights/search?...",
  "errors": []
}
```

Booking response'u tek-link ve ayrı-bilet seçeneklerini birlikte korur:

```json
{
  "offerId": "<dönüş-sourceOfferId>",
  "bookingOptions": [
    {
      "sourceOptionId": "<google-booking-token>",
      "seller": "Pegasus + AJet",
      "totalPrice": 34213,
      "currency": "TRY",
      "bookingLinks": [
        { "seller": "Pegasus", "totalPrice": 16122, "bookingUrl": "https://www.google.com/travel/clk/f?..." },
        { "seller": "AJet", "totalPrice": 18091, "bookingUrl": "https://www.google.com/travel/clk/f?..." }
      ],
      "baggageNotes": ["Pegasus bagaj koşulları: https://...", "AJet bagaj koşulları: https://..."]
    },
    {
      "sourceOptionId": "<google-booking-token>",
      "seller": "Gotogate",
      "totalPrice": 40071,
      "currency": "TRY",
      "bookingUrl": "https://www.google.com/travel/clk/f?..."
    }
  ],
  "bookingUrl": "https://www.google.com/travel/clk/f?...",
  "priceIsEstimated": false,
  "priceInsights": {
    "lowestPrice": 34213,
    "priceLevel": "low",
    "typicalPriceRange": [37500, 64000]
  },
  "errors": []
}
```

Otel response'u `StaySearchResult` biçimindedir:

```json
{
  "query": {
    "location": "Amsterdam",
    "checkInDate": "2026-10-03",
    "checkOutDate": "2026-10-06",
    "guests": { "adults": 2, "children": 0 },
    "propertyType": "hotels",
    "currency": "TRY",
    "locale": "tr"
  },
  "stays": [
    {
      "source": "google_hotels_browser",
      "sourceStayId": "<google-property-id>",
      "name": "Örnek Hotel",
      "propertyType": "hotel",
      "hotelClass": 4,
      "rating": 4.1,
      "reviewCount": 1766,
      "gps": { "latitude": 52.37, "longitude": 4.89 },
      "ratePerNight": 4070,
      "totalPrice": 12210,
      "currency": "TRY",
      "priceIsEstimated": false,
      "otaPrices": [{ "seller": "Booking.com", "ratePerNight": 4070 }],
      "images": ["https://example.com/hotel.jpg"],
      "bookingUrl": "https://www.google.com/aclk?...",
      "retrievedAt": "2026-08-04T12:00:00.000Z"
    }
  ],
  "priceInsights": { "lowestPrice": 4070 },
  "searchUrl": "https://www.google.com/travel/search?...",
  "errors": []
}
```

Gidiş-dönüş akışı üç adımdır: `/search/flights` gidişleri, `/search/flights/returns` seçilen gidişle uyumlu dönüşleri, `/search/flights/bookings` ise tam parkurun satıcı ve satın alma seçeneklerini döndürür. Dönüş response'undaki her teklif hem `outboundSegments` hem `returnSegments` içerir.

Booking response'unda tek satıcıyla tamamlanan seçeneklerde `bookingUrl` bulunur. Ayrı bilet gerektiren daha ucuz kombinasyonlar tek linkmiş gibi gösterilmez; bunlarda her satın alma adımı `bookingLinks` listesinde tutulur. Üst seviyedeki `bookingUrl`, tüm parkuru tek bağlantıyla satın aldıran en ucuz seçenektir. `baggageNotes` şu anda parkurdaki taşıyıcıların resmi bagaj koşulu bağlantılarını içerir; tarife özel kilogram/adet hakkı Google'ın kodlanmış alanlarından güvenilir biçimde doğrulanmadıkça tahmin edilmez.

Uçuş seçim token'ları process içinde 30 dakika saklanır. `/returns` ve `/bookings` çağrıları ilk aramayı yapan aynı SearchApi instance'ına gitmelidir; çoklu instance kurulumunda sticky routing veya ortak bir seçim deposu gerekir.

## Route'lar

| Method | Route | İşlev |
|---|---|---|
| `GET` | `/health` | Token gerektirmeyen sağlık ve browser durumu |
| `GET` | `/v1/browser` | BrowserPool durumu |
| `POST` | `/v1/browser/start` | BrowserPool'u hazırla |
| `POST` | `/v1/browser/stop` | Context'leri ve browser'ı kapat |
| `GET` | `/v1/contexts` | Açık context'leri listele |
| `POST` | `/v1/contexts` | Context aç; opsiyonel `{ "url": "https://..." }` |
| `GET` | `/v1/contexts/:id` | Context ve capture sayacı |
| `POST` | `/v1/contexts/:id/navigate` | Mevcut ana sekmeyi `{ "url": "https://..." }` adresine götür |
| `DELETE` | `/v1/contexts/:id` | Context'i kapat ve capture'ı flush et |
| `GET` | `/v1/captures/:id` | In-memory capture özeti |
| `GET` | `/v1/locations/flights` | Uçuş lokasyon suggestion sonuçlarını ve Google entity ID'lerini getir |
| `POST` | `/v1/search/flights` | Uçuş ara ve normalize edilmiş teklifleri döndür |
| `POST` | `/v1/search/flights/returns` | Seçilen gidişin `offerId` değeriyle uyumlu dönüşleri döndür |
| `POST` | `/v1/search/flights/bookings` | Tam uçuş seçiminin `offerId` değeriyle satıcı, satın alma linki, bagaj koşulları ve fiyat içgörülerini döndür |
| `POST` | `/v1/search/hotels` | Otel ara ve normalize edilmiş tesisleri döndür |
| `POST` | `/v1/search/vacation-rentals` | Kiralık ev, villa, apart ve daire ara |

## Capture formatı

```text
.api-capiture/
└── 2026-08-04/
    └── <context-id>/
        ├── session.json
        ├── index.ndjson
        └── exchanges/
            ├── 000001-<capture-id>.json
            └── 000002-<capture-id>.json
```

Exchange kaydı şunları içerir:

- method, URL, resource type, request headers/body;
- status, response headers/body ve süre;
- JSON/text/base64 encoding bilgisi;
- orijinal/capture edilen byte sayısı ve truncation bayrağı;
- başarısız network isteklerinde hata metni.

Body boyutu `CAPTURE_MAX_BODY_BYTES` ile sınırlıdır. Binary payload base64 saklanır. Hassas alanları gerçekten ham görmek gerekiyorsa yalnız kontrollü lokal kullanımda `CAPTURE_INCLUDE_SENSITIVE=true` yapılabilir. `.api-capiture` Git tarafından ignore edilir.

## Motor seçimi

```dotenv
BROWSER_ENGINE=patchright
BROWSER_HEADLESS=false
BROWSER_CHANNEL=chrome
```

Standart Playwright karşılaştırması için `BROWSER_ENGINE=playwright` kullanın. Her iki motor da aynı BrowserManager seam'i arkasındadır; route ve capture formatı değişmez.

## Doğrulama

```bash
npm run typecheck
npm test
npm run build
BROWSER_CHANNEL=chrome npm run smoke:browser
BROWSER_CHANNEL=chrome BROWSER_ENGINE=patchright BROWSER_HEADLESS=false npm run smoke:search
```

Manuel gözlem gerekmeyen sunucu ortamında, hedefle stabilite doğrulandıktan sonra `BROWSER_HEADLESS=true` kullanılabilir.

Yalnız otomatik erişime izin verilen veya yazılı izin alınmış hedeflerde kullanın. Anti-detection sürücüsü erişim izni sağlamaz.

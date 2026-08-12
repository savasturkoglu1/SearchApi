# FlightScanner brief — isteğe bağlı konaklama görselleri

## Amaç

SearchApi'nin otel ve kiralık yer endpointleri artık görselleri yalnız açıkça
istendiğinde döndürüyor. FlightScanner tarafında bu seçeneği `StaySearchQuery` üzerinden
uçtan uca taşıyın.

Kapsanan endpointler:

- `POST /v1/search/hotels`
- `POST /v1/search/vacation-rentals`

Yeni request alanı:

```ts
includeImages?: boolean; // default false
```

Davranış:

- Alan gönderilmezse veya `false` ise SearchApi response'undaki tesislerde `images`
  alanı bulunmaz.
- `true` ise Google cevabında bulunan görsel URL'leri `NormalizedStay.images` içinde
  döner.
- Response tipi değişmedi; `NormalizedStay.images?: string[]` zaten opsiyonel.

## Değiştirilecek FlightScanner dosyaları

```text
src/adapters/hotel-types.ts
src/adapters/browser-google-stays.ts
src/agents/tools/search-tool/search-tools.ts
tests/browser-search-api-adapters.test.ts
```

## 1. Provider-bağımsız query tipini genişletin

`src/adapters/hotel-types.ts`:

```ts
export interface StaySearchQuery {
  location: string;
  checkInDate: string;
  checkOutDate: string;
  guests: GuestCounts;
  propertyType?: "any" | "hotels" | "vacation_rentals";
  includeImages?: boolean; // yeni; varsayılan false
  // mevcut diğer alanlar...
}
```

`NormalizedStay` değiştirilmemelidir; aşağıdaki mevcut alan doğrudur:

```ts
images?: string[];
```

## 2. Browser SearchApi adapter requestine aktarın

`src/adapters/browser-google-stays.ts` içindeki hem hotel hem vacation-rental için
kullanılan ortak request body'ye ekleyin:

```ts
const payload = await this.client.post(endpoint, {
  destination: query.location,
  checkIn: query.checkInDate,
  checkOut: query.checkOutDate,
  adults: query.guests.adults,
  rooms: this.rooms,
  children: query.guests.children,
  includeImages: query.includeImages ?? false,
  marketProfile: this.marketProfile,
});
```

Önemli noktalar:

- `propertyType: "any"` iki endpointi çağırır; aynı `includeImages` değeri iki body'ye
  de gönderilmelidir.
- Adapter response'ta ayrıca image filtrelemesi yapmamalıdır. SearchApi `false`
  durumunda alanı zaten kaldırır.
- `staySchema.images: z.array(z.string()).optional()` değişmeden kalmalıdır.
- Eksik `images` alanı contract error değildir.
- `true` istekten sonra dahi bazı tesislerde görsel bulunmayabilir; boş/eksik alanı
  hata saymayın.

## 3. Agent tool inputuna ekleyin

Kullanıcı veya planner bu davranışı seçebilsin diye
`src/agents/tools/search-tool/search-tools.ts` içindeki `staySearchInputSchema` alanına
ekleyin:

```ts
includeImages: z
  .boolean()
  .default(false)
  .describe("Konaklama görsel URL'lerini döndür; yalnız gerçekten gösterilecekse true kullan"),
```

`searchStays` execute fonksiyonu `maxResults` dışındaki inputu doğrudan
`StaySearchQuery` yaptığı için ek bir mapping gerekmemelidir:

```ts
execute: async ({ maxResults, ...input }) => {
  const query: StaySearchQuery = input;
  // ...
}
```

Flexible trip sonucunda da görsel istenebilmesi gerekiyorsa `stayPreferences` içine aynı
alanı opsiyonel/default false ekleyin ve oluşturulan `stayQuery`'ye taşıyın:

```ts
stayPreferences: z.object({
  // mevcut alanlar...
  includeImages: z.boolean().default(false),
}).optional();

const stayQuery: StaySearchQuery = {
  // mevcut alanlar...
  includeImages: stayPreferences?.includeImages ?? false,
};
```

Flexible trip için default mutlaka `false` kalmalıdır; birden fazla tarih kombinasyonunda
gereksiz büyük response üretmeyin.

## 4. Tool output davranışı

Mevcut `cleanStay()` görselleri en fazla üç URL ile sınırlandırıyor:

```ts
images: images?.slice(0, 3),
```

Bu sınır korunmalıdır. Sonuç olarak:

- SearchApi → tüm bulunan görsel URL'leri;
- FlightScanner agent tool → en fazla ilk 3 görsel URL'si

döndürür.

`includeImages: false` durumunda `images: undefined` JSON serialize edilirken response'ta
yer almamalıdır. İstenirse `cleanStay()` alanı tamamen kaldıracak biçimde conditionally
spread kullanabilir, fakat public JSON davranışı aynı kaldığı sürece zorunlu değildir.

## 5. Request örnekleri

Varsayılan/hafif arama:

```json
{
  "destination": "Amsterdam",
  "checkIn": "2026-10-15",
  "checkOut": "2026-10-22",
  "adults": 2,
  "rooms": 1,
  "children": 0,
  "includeImages": false,
  "marketProfile": "TR-IST"
}
```

Görselli arama:

```json
{
  "destination": "Amsterdam",
  "checkIn": "2026-10-15",
  "checkOut": "2026-10-22",
  "adults": 2,
  "rooms": 1,
  "children": 0,
  "includeImages": true,
  "marketProfile": "TR-IST"
}
```

## 6. Test beklentileri

`tests/browser-search-api-adapters.test.ts` içinde en az aşağıdaki durumları doğrulayın:

1. `includeImages` belirtilmemiş query için hotel request body `includeImages: false`
   içerir.
2. `includeImages: true` query için hotel request body `includeImages: true` içerir.
3. `propertyType: "any"` durumunda hem hotel hem vacation-rental body aynı değeri taşır.
4. `false` response'unda `images` alanı olmayan stay contract validation'dan geçer.
5. `true` response'undaki `images` listesi normalize sonuçta korunur.
6. Tool outputu görsel listesini en fazla üç URL ile sınırlar.
7. Flexible trip default olarak `includeImages: false` kullanır.

Mevcut request body assertion şu alanı içerecek şekilde güncellenmelidir:

```ts
assert.deepEqual(body, {
  destination: "Amsterdam",
  checkIn: "2026-09-17",
  checkOut: "2026-09-20",
  adults: 2,
  rooms: 2,
  children: 0,
  includeImages: false,
  marketProfile: "TR-IST",
});
```

Görselli senaryo:

```ts
const result = await adapter.search({
  ...baseStayQuery,
  propertyType: "hotels",
  includeImages: true,
});

assert.equal(capturedBody.includeImages, true);
assert.deepEqual(result.stays[0]?.images, ["https://images.example/hotel.jpg"]);
```

## 7. Acceptance kriterleri

- Mevcut callers değişiklik yapmadan çalışmaya devam ediyor.
- Default istekler SearchApi'ye `includeImages: false` gönderiyor.
- Yalnız açıkça isteyen query `true` gönderiyor.
- Hotel, vacation-rental ve `propertyType: any` aynı davranışı sergiliyor.
- `NormalizedStay.images` opsiyonel kalıyor.
- Agent tool varsayılan olarak görsel istemiyor ve görselli sonuçta en fazla 3 URL döndürüyor.
- FlightScanner typecheck, adapter testleri ve search-tool testleri başarılı.

SearchApi sözleşme referansı:
[`flightscanner-adapter-integration.md`](flightscanner-adapter-integration.md#8-konaklama-apisi)

Brief tarihi: **6 Ağustos 2026**.

# Kaliber prisjakt

En liten sida att gå in på när snuset är slut. Ett tryck på knappen, och sidan
hämtar dagens priser, och den billigaste butiken visas stort — ett klick till och han
står i butikens kassa.

**Varan:** Kaliber Original, portionssnus från Swedish Match — Large, 18 g, 20 prillor,
7,5 mg/prilla, EAN 7311250449406. Inte "White Portion", inte Lös eller Slim.

**Volymerna:** 10, 20 eller 30 dosor. **Aldrig 50** — vid den mängden hinner tobaken
torka innan han gått igenom så många. 50-pack får inte dyka upp i rankningen eller
rekommenderas, även om det råkar bli billigare per dosa.

---

## Prisberäkningen — rör den inte utan att förstå den

Ingen butik säljer ett 20-pack. **@20 = 2 × 10-pack.** Priset kan alltså inte slås upp,
det måste pusslas ihop: minsta totalkostnad för ett antal dosor genom valfri kombination
av butikens paket (dynamisk programmering). Det är också därför iSnus @30 landar på
3 × 10-pack à 777 kr och inte på deras 30-pack à 779 kr.

Tre regler som styr och som lätt går sönder om man "förenklar":

1. **Aldrig fler än 30 dosor.** Taket är hårt (`MAX_CANS`) och gör ett 50-pack omöjligt
   att välja, oavsett hur billigt det är per dosa.
2. **Fler dosor bara när det kostar färre kronor.** Ett kampanjat 30-pack som är
   billigare *totalt* än 2 × 10-pack föreslås — då står det utskrivet att antalet blir ett
   annat. Men aldrig "billigare per dosa, dyrare i kassan".
3. **Går det exakta antalet inte att pussla ihop får butiken inget pris för det antalet.**
   En butik som bara säljer 30-pack ska inte vinna frågan "var är 10 dosor billigast".

Samma regler finns på två ställen — `bestFor` i `fetch-prices.mjs` och `solve` i
`index.html` (sidan räknar om lokalt om filen saknar ett värde). Ändras den ena måste den
andra ändras med. Båda är verifierade mot brute force över tusentals slumpade prisstegar.

---

## Spara som app

- **iPhone/iPad (Safari):** Dela-knappen → *Lägg till på hemskärmen*
- **Mac (Safari):** Arkiv → *Lägg till i Dock*
- **Chrome/Edge:** installera-ikonen i adressfältet → *Installera*

Då öppnas den utan adressfält och flikar, som en vanlig app. Det är
`manifest.webmanifest` som gör det, och ikonen kommer från `icon.svg` / `icon-192.png` /
`icon-512.png`.

---

## Hur priserna uppdateras

**En robot hämtar, sidan läser.**

GitHub Actions kör `fetch-prices.mjs` var 12:e timme (05:17 och 17:17 UTC) och committar
`prices.json` bara när något faktiskt ändrats. Sidan läser den filen — inget annat.
Knappen *Hämta dagens priser* hämtar om samma fil, vilket går på en bråkdel av en sekund.

**Sidan skrapar aldrig butiker själv.** Det gjorde den tidigare, genom en gratis
CORS-mellanhand, och det fungerade inte: uppmätt gick ett av tre försök igenom, och det
som gick igenom tog nästan åtta sekunder — sidan svarade "kunde inte hämta" i stort sett
varje gång. Dessutom fanns då två uppsättningar prisparsers som kunde börja säga olika
saker om samma butik. Nu finns bara en, den i `fetch-prices.mjs`.

Datumet på prislappen säger när priserna senast kontrollerades.

> **En sak att hålla koll på:** GitHub pausar schemalagda körningar i publika repon efter
> 60 dagar utan aktivitet. Då slutar priserna uppdatera sig — tyst. GitHub mejlar en
> varning innan det händer; klicka *Enable workflow* i Actions-fliken, eller tryck
> *Run workflow* manuellt, så räknas repot som aktivt igen.
>
> Sidan har ett eget skyddsnät mot just det: är `prices.json` äldre än **48 timmar**
> skrivs en varning ut om att kontrollera priset i butiken, och äldre än **14 dagar**
> märks prislappen "Billigast enligt gammalt pris". Workflow-körningen larmar dessutom
> (rött bygge → mejl) om noll butiker gick att läsa.

---

## Lägga till eller ändra en butik

Allt bor i `retailers.json` — sidan och hämtaren har inga butiker hårdkodade.

```json
{
  "retailer": "Snuslagret",
  "domain": "snuslagret.se",
  "url": "https://snuslagret.se/produkt/snus/portionssnus/kaliber-original/",
  "platform": "woocommerce",
  "cluster": "snushallen",
  "cluster_primary": true,
  "note": "Fri frakt redan från 49 kr."
}
```

| Fält | Vad det gör |
|---|---|
| `url` | Produktsidan för **Kaliber Original**. Byter butiken URL är det bara den här raden som behöver ändras. |
| `platform` | Hur priset läses: `woocommerce`, `shopify`, `prestashop`, `haypp`, `grocery`, `js-rendered`, `unknown`. Vet du inte — skriv `unknown`, hämtaren provar sig fram. |
| `cluster` | Butiker som är **samma operatör** i botten. Snuslagret, Billigsnus och Snusstocken är samma bolag. Bara en av dem visas i topplistan, annars ser den ut som tre butiker fast det är en. Sätt **aldrig** ett kluster på misstanke — samma artikelnummer räcker inte, det är Swedish Match nummer och står hos nästan alla. Krävs: samma priser, samma butiksplattform. |
| `cluster_primary` | Vem som får representera klustret **när priserna är lika**. Skiljer de sig går alltid den billigaste först — ett lägre pris får aldrig döljas bakom ett högre. |
| `note` | Fritext för den som underhåller registret. Syns inte på sidan. |

Butiker som inte ger ifrån sig äkta paketdata hamnar automatiskt i `skipped` i
`prices.json`, med orsak, och rankas aldrig — hellre tyst bortsorterad än ett påhittat
pris. Klarar en butik bara *något* av antalen (säljer t.ex. bara 30-pack) behålls den och
syns just där — den kastas inte längre bort helt.

**Fel-vara-vakten:** hämtaren jämför sidans titel mot `product.reject_keywords` och kräver
att sidan faktiskt handlar om Kaliber Original (eller innehåller EAN:en). Redirectar en
gammal länk till *White Portion* eller *Slim* avvisas butiken i stället för att en annan
varas prisstege skrivs in som vår.

---

## Säkerhetsregeln — läs den här

**Hämtaren får bara läsa öppna produktsidor.** Vanlig HTML, plus Shopifys publika
`.js`-endpoint för en produkt. Det är allt.

**Gräv aldrig fram en API-nyckel ur en sajts JavaScript för att fråga dess backend eller
databas.** En publik nyckel i klientkod är inte en inbjudan — att räkna upp tabeller bakom
den är precis mönstret som läcker persondata när en butik glömt låsa sin databas. Butiker
vars pris inte går att läsa ur den öppna sidan utelämnas hellre (se `excluded` i
`retailers.json`).

Regeln gäller även om det vore enklare, snabbare eller om butiken "verkar ha ett öppet
API". Går ett pris inte att läsa från den öppna sidan, så läses det inte — butiken hamnar
i `unparsed` och det är helt okej.

---

## Filerna

| Fil | Vad det är |
|---|---|
| `index.html` | Hela sidan — utseende och logik i en fil. |
| `prices.json` | Senast hämtade priser. Autogenererad — handredigera aldrig. |
| `retailers.json` | Butiksregistret. **Det är här du ändrar saker.** |
| `fetch-prices.mjs` | Hämtar priserna och skriver `prices.json`. |
| `sw.js` | Gör att appikonen öppnar sidan även utan nät. Utan den får han webbläsarens felsida utan adressfält — och det sparade priset som ligger inbakat i `index.html` blir oåtkomligt just när det behövs. Höj `CACHE`-namnet (`-v1` → `-v2`) om appskalet ändras. |
| `.github/workflows/refresh-prices.yml` | Schemat som kör hämtaren var 12:e timme. |
| `manifest.webmanifest` | Gör att sidan kan sparas som app. |
| `icon.svg` · `icon-192.png` · `icon-512.png` | Appikonen. |
| `apple-touch-icon.png` | Samma ikon i 180 px — den iPhone använder på hemskärmen. |
| `.nojekyll` | Tom fil. Säger till GitHub Pages att inte köra Jekyll på mappen. |

### Om ikonen

Motivet är en snusdosa ovanifrån med en prispil nedåt. Bara fyllda ytor, inga tunna
linjer — tunnaste elementet är ~1,9 px vid 32 px favicon, så den håller ihop även liten.

`icon.svg` har rundade hörn (radie 21,9 %, samma som iOS squircle) och används som
favicon. PNG-erna är avsiktligt **fyrkantiga utan hörnradie** så att operativsystemet får
maska själv — därför är de märkta `maskable` i manifestet. Motivet ligger innanför
maskbar säker zon (ytterdiametern är 75 % av ikonbredden, gränsen går vid 80 %), så inget
klipps bort oavsett vilken form Android eller macOS väljer.

Ska ikonen ritas om: ändra `icon.svg` och rendera om PNG-erna med macOS egna verktyg —
inga beroenden behövs.

```bash
cd <repo-mappen>
sed 's| rx="112"||' icon.svg > /tmp/fullbleed.svg          # ta bort hörnradien
qlmanage -t -s 512 -o /tmp /tmp/fullbleed.svg && cp /tmp/fullbleed.svg.png icon-512.png
qlmanage -t -s 192 -o /tmp /tmp/fullbleed.svg && cp /tmp/fullbleed.svg.png icon-192.png
qlmanage -t -s 180 -o /tmp /tmp/fullbleed.svg && cp /tmp/fullbleed.svg.png apple-touch-icon.png
```

`qlmanage` och `sips` följer med macOS — inget behöver installeras. (Maskinen saknar
`rsvg-convert` och ImageMagick, så gå inte den vägen.)

### Färger

Ljust tema, samma varmvita papper som sidan (`--paper` i `index.html`):

| | |
|---|---|
| Bakgrund / temafärg | `#F4EEDF` (varmvitt papper) |
| Mörk grön (ikon, accent) | `#14513B` |
| Kräm (ikonens lock) | `#FBF7EC` |
| Sand (ikonens ringar) | `#E3D8BC` · `#CBBB97` |

Byter sidan bakgrundsfärg: ändra `background_color` **och** `theme_color` i
`manifest.webmanifest` till samma värde, annars blinkar det till i fel färg när appen
startar.

Sidan har även ett mörkt läge (`#12100C`) som slår på med systemets utseende. Det styrs
av `<meta name="theme-color" media="(prefers-color-scheme: dark)">` i `index.html`, och
den taggen vinner över manifestets `theme_color` i webbläsaren — manifestets värde
används för startskärmen, som alltid är ljus. Ingen konflikt, men bra att veta.

### Kopplingen mellan sidan och app-skalet

Det här står i `<head>` i `index.html` och är det som gör sidan installerbar. Rör man
det slutar appen fungera som app:

```html
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="icon.svg">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="theme-color" content="#F4EEDF" media="(prefers-color-scheme: light)">
<meta name="apple-mobile-web-app-title" content="Kaliber">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

**Manifestet måste ligga i en egen fil.** Frestas man att lägga in det som en
`data:`-länk direkt i HTML:en går det inte att peka ut ikonerna — relativa sökvägar har
inget att räkna från i en data-URL, och appen installeras utan ikon.

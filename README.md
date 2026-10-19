# Hra Multiplayer (LAN)

Jednoduchá 2D pixel hra s pohledem shora. Všichni na stejné WiFi se můžou připojit a chodit po mapě.

## Jak to spustit

**Jen jeden člověk (host)** potřebuje [Node.js](https://nodejs.org). Ostatním stačí prohlížeč.

```bash
npm install      # jen poprvé
npm start
```

Server vypíše adresu, třeba:

```
Ostatní na stejné WiFi: http://192.168.1.23:3000
```

Tu adresu ostatní otevřou v prohlížeči (funguje i z mobilu, ale ovládá se klávesnicí).

### Když se ostatní nemůžou připojit
- Musíte být **na stejné WiFi**.
- **Firewall**: Mac při prvním spuštění se zeptá „Povolit příchozí spojení pro node?“ → **Povolit**. Na Windows povolit Node.js v dialogu firewallu (zaškrtnout i „Soukromé sítě“).
- **Školní WiFi** často zakazuje, aby se zařízení viděla navzájem („client isolation“). Pak to nepůjde a je potřeba hotspot z mobilu – všichni se připojí na hotspot a funguje to.

## Jak funguje multiplayer

```
  Prohlížeč hráče A ─┐                        ┌─> všichni dostanou
  Prohlížeč hráče B ─┼── "držím klávesu W" ──>│ SERVER │── "A je na [120, 80],
  Prohlížeč hráče C ─┘                        └─>       B je na [300, 40] ..."
```

1. **Server** (`server.js`) běží na počítači hosta. Jako u Minecraftu – jeden „hostuje“, ostatní se připojí na jeho IP adresu.
2. Prohlížeč se k serveru připojí přes **WebSocket** – trvalé spojení, kterým jdou zprávy oběma směry.
3. Klient serveru posílá **jen to, které klávesy drží** (`{type: "input", up: true, ...}`).
4. Server 30× za sekundu spočítá nové pozice všech hráčů a pošle je všem (`{type: "state", players: [...]}`).
5. Klient jen **kreslí**, co mu server poslal (a pohyb trochu vyhlazuje, aby nebyl trhaný).

Server je „šéf“ – rozhoduje o všem důležitém. Díky tomu všichni vidí to samé a nikdo nemůže podvádět.

## Obtížnost

Hra začíná klidně (2 zelení slizi, nepřátelé se neobjevují blízko hráčů, nový hráč je 3 s nezranitelný)
a každých 45 s stoupne úroveň (max. 10): přibývají nepřátelé (až 8), jsou rychlejší a vidí hráče z větší dálky,
od 3. úrovně přibývají Ohniví slizi a od 5. Obří slizi. Když hru všichni opustí, začne se znovu od 1. úrovně.
Všechna čísla jsou v objektu `DIFFICULTY` nahoře v `server.js`.

## Soubory

| Soubor | Co dělá |
|---|---|
| `server.js` | herní server – pozice hráčů, herní smyčka, posílání stavu |
| `public/game.js` | klient – ovládání, kreslení mapy a postaviček |
| `public/index.html` | stránka s plátnem a přihlašovacím oknem |

## Jak přidávat věci

- **Nová akce hráče** (např. střelba): v `game.js` pošli `send({ type: "shoot" })`, v `server.js` ji zpracuj v `ws.on("message")`.
- **Nový herní objekt** (mince, nepřátelé): ulož ho na serveru, posílej ve zprávě `state` a v `game.js` ho nakresli ve funkci `frame`.
- **Velikost mapy**: `MAP_W` / `MAP_H` – musí být stejné v `server.js` i `game.js`.

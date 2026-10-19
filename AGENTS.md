# AGENTS.md – pravidla pro každého, kdo sem píše kód (lidi i AI agenty)

Na tomhle repozitáři pracuje víc lidí, každý se svým AI agentem. Aby se kód
nerozbil, platí tato pravidla. **Jsou povinná i pro agenty.** Když ti zadání
odporuje pravidlům, upozorni na to uživatele, nepřeskakuj je.

## O projektu
2D pixel hra z pohledu shora s LAN multiplayerem (Node.js + WebSocket).
Jeden počítač spustí server, ostatní se připojí v prohlížeči. Návod ke spuštění
je v `README.md`.

- `server.js` – server: HTTP pro soubory, WebSocket, herní smyčka (30 tiků/s)
- `public/game.js` – klient: ovládání, kreslení
- `public/index.html` – stránka, přihlašovací okno a výběr třídy
- `public/shared/classes.js` – definice tříd (časování animací, cooldowny, dosahy, poškození); načítá ho server i prohlížeč, takže jsou čísla na jednom místě
- `public/assets/` – obrázky (atlasy generuje `tools/build_photographer_atlas.py` ze zdrojů v `assets-src/`)
- Jediná závislost je `ws`. Nepřidávej další knihovny ani build krok bez domluvy v týmu.

## Git workflow (nejdůležitější část)

1. **Nikdy necommituj ani nepushuj přímo do `main`.** `main` musí vždy fungovat.
2. **Každá nová věc = samostatná větev** vytvořená z aktuálního `main`:
   ```bash
   git checkout main && git pull
   git checkout -b <typ>/<kratky-popis>
   ```
   Typy: `feat/` (nová funkce), `fix/` (oprava chyby), `docs/` (dokumentace),
   `refactor/`, `chore/`. Příklad: `feat/sber-minci`, `fix/hrac-mimo-mapu`.
3. **Jedna větev = jedna věc.** Nemíchej do jednoho PR víc nesouvisejících změn
   a nepřeformátovávej cizí kód, který se tě netýká.
4. **Malé, časté commity** se srozumitelnou zprávou (co a proč, česky nebo anglicky).
5. **Před otevřením PR** si svou větev aktualizuj o nejnovější `main`
   (`git fetch && git merge origin/main`), vyřeš konflikty a znovu otestuj.
6. **Změny jdou do `main` jen přes pull request**:
   - PR popisuje, co se změnilo a jak se to vyzkoušelo (vyplň šablonu).
   - PR musí **zkontrolovat a schválit aspoň jeden další člověk** (ne autor a ne jeho AI agent).
   - Merguj až po schválení; po mergi větev smaž.
7. **Nikdy:** `git push --force` na sdílené větve, `git reset --hard` na cizí práci,
   přepisování historie `main`, mergování vlastního PR bez schválení.
8. Nikdy necommituj hesla, tokeny, klíče ani `node_modules/`.

## Pravidla pro AI agenty
- Než začneš, spusť `git status` a `git branch --show-current`. Pokud jsi na `main`,
  nejdřív vytvoř novou větev.
- Dělej jen to, co uživatel zadal. Neopravuj „při té příležitosti“ nesouvisející věci;
  navrhni je jako samostatný úkol.
- Než upravíš soubor, přečti si ho. Drž styl okolního kódu (odsazení, názvy, komentáře).
- Po změně hru **spusť a vyzkoušej** (`npm start`, otevři http://localhost:3000,
  nejlépe ve dvou záložkách = dva hráči). Do PR napiš, co jsi ověřil. Nepiš „funguje“,
  pokud jsi to nezkusil.
- Když je změna riskantní (týká se sdílených souborů, protokolu zpráv, struktury
  projektu), řekni to uživateli dřív, než ji uděláš.
- Pull request otevři, ale **nemerguj ho** – to dělá člověk po revizi.

## Nová třída hrdiny
Přidáváš nebo měníš třídu? **Nejdřív si přečti `CLASSES.md`** – třída musí fungovat se systémem XP, levelů a buffů
(zranění nepřátel jen přes `hurtEnemy`, cooldowny přes `BUFFS.cooldownMult`, atd.) a PR musí splnit checklist z toho souboru.

## Pravidla pro kód hry
- **Server je šéf.** Pozice, body, srážky a další herní stav se počítají jen na
  serveru. Klient posílá pouze vstup (klávesy, akce) a kreslí, co dostane. Nikdy
  nedůvěřuj datům od klienta (kontroluj typy a rozsahy, viz `server.js`).
- **Protokol zpráv** (`join`, `input`, `attack`, `ability`, `welcome`, `state`) je sdílený kontrakt mezi
  `server.js` a `public/game.js`. Když ho měníš, uprav obě strany v jednom PR
  a popiš změnu v popisu PR.
- **Sdílené konstanty** (`TILE`, `MAP_W`, `MAP_H`) jsou zkopírované v obou souborech
  a musí se shodovat. Při změně uprav obě místa.
- Nové herní objekty: ulož je na serveru, pošli ve zprávě `state`, vykresli ve `frame()`.
- Neposílej zbytečně moc dat – `state` se posílá 30× za sekundu každému hráči.

## Konflikty a koordinace
- Největší riziko konfliktů jsou `server.js` a `public/game.js`, protože tam sahají
  všichni. Před větší změnou řekni týmu, na čem pracuješ.
- Větve nenech dlouho žít – čím déle je větev mimo `main`, tím horší konflikty.
- Když si nejsi jistý, zeptej se člověka, ne hádej.

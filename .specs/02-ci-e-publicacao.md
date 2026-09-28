# 02 — CI no Forgejo, mirror e publicação no npm

## 1. Fluxo

```text
Forgejo (origin)                                   GitHub (mirror)
 push main / PR ─► ci.yml: format, typecheck,
                   build, test, verify-package
                   + ciir (dogfooding)
 tag vX.Y.Z ─────► ci.yml (+ envio ao indexer)
             └───► mirror-to-github.yml ─(janela)─► tag vX.Y.Z ─► release.yml
                                                                   build + verify
                                                                   publish (environment "npm")
                                                                   ─► npmjs.com
```

| Workflow | Onde | Quando | O quê |
|---|---|---|---|
| `.forgejo/workflows/ci.yml` | Forgejo | push em `main`, tags `v*`, PRs, manual | `validate`: `npm ci`, `format:check`, `typecheck`, `build`, `test`, `scripts/verify-package.sh 0.0.0-ci.<n>`. `ciir`: analisa o próprio repositório; em tag, envia ao indexer se `CIIR_BASE_URL` estiver configurada |
| `.forgejo/workflows/mirror-to-github.yml` | Forgejo | push em `main`/`v*`, cron diário 20:00 (São Paulo), manual | Espelha todas as branches e tags. Dias úteis: só entre 20:00 e 07:00; fim de semana: sempre. Igual ao do C# |
| `.github/workflows/release.yml` | GitHub | tag `v*` (publica), manual (dry run) | `build`: validações + pacote verificado como artifact. `publish`: aguarda aprovação no environment `npm` e publica com provenance; pre-release (`v1.2.0-rc.1`) vai para o dist-tag `next` |

## 2. `scripts/verify-package.sh <versão>`

Equivalente ao `verify-tool-package.sh` do C#: empacota com a versão pedida, confere o conteúdo
(CLI, schema, README, LICENSE presentes; `src/`, `tests/`, `fixtures/`, `scripts/`, `.specs/`
ausentes), executa via `npx --package=<tgz>` conferindo `--version` e roda um smoke test no fixture
com `--fail-on-error`. Restaura `package.json`/`package-lock.json` ao final.

## 3. Autenticação no npm

1. **Trusted Publishing (OIDC)** — preferido, sem token de longa duração. Configurado no
   npmjs.com (pacote → Settings → Trusted publisher: GitHub Actions, `blogdoft`,
   `code-brain-angular`, `release.yml`, environment `npm`). Exige npm ≥ 11.5.1 (o job atualiza o
   npm) e o pacote já existente.
2. **`NPM_TOKEN`** — necessário só para a primeira versão (o Trusted Publisher só pode ser
   configurado num pacote que já existe). Depois pode ser removido.

Republicar a mesma versão é inócuo: o job verifica `npm view` e pula (equivalente ao
`--skip-duplicate` do NuGet).

## 4. Fora de escopo

GitVersion (a versão vem só da tag), publicação no registro npm do Forgejo, imagem Docker.

# Angular / TypeScript Code Intelligence IR Generator

## 1. Objetivo

Criar uma ferramenta de linha de comando (Node.js) que analisa estaticamente código-fonte
**TypeScript/JavaScript**, com entendimento específico de **Angular**, e gera a mesma
**Code Intelligence Intermediate Representation — CIIR** produzida pelo `code-csharp-ciir` e pelo
`code-java-ciir`.

O CIIR gerado é consumido pelo `code-ciir-indexer` (projeto **code-brain**: `code-ciir-api`,
`code-ciir-indexer`, `code-rag-front`). Por isso o requisito central é **conformidade com o
contrato**: todo registro emitido precisa ser válido contra `schemas/ciir.schema.json` (cópia
literal do schema `1.2` do `code-csharp-ciir`) e seguir as mesmas regras de identidade, hashing,
`embeddingText` e artefatos de saída.

```text
C# / Roslyn ─────────────────┐
Java / JavaParser ───────────┤
TypeScript + Angular (este) ─┤
                             ▼
                           CIIR ──► code-ciir-indexer ──► code-ciir-api / code-rag-front
```

A semântica dos conceitos CIIR está em `docs/ciir-specification.md` do `code-csharp-ciir`; este
documento **não a repete** — descreve apenas como TypeScript/Angular é mapeado para ela e o que
diverge (e por quê). O resumo específico deste gerador fica em `docs/ciir-specification.md`
deste repositório.

---

# 2. Forma de entrega

**CLI** (preferência do pedido). Uma interface visual não é necessária: a ferramenta é pensada
para pipeline (CI) e para uso local, igual ao `ciir` do C#.

```bash
code-brain-angular <path> [--output <dir>] [--verbose] [--no-progress] [--no-banner]
                   [--include-source] [--include-tests] [--fail-on-error]
                   [--send [<base-url>] --projectId <guid> [--token <jwt> | --clientId <id> --clientSecret <secret>] [--insecure]]
```

Distribuição: pacote npm público `code-brain-angular`, sem escopo, com o binário
`code-brain-angular` (não `ciir`, para não colidir com a ferramenta .NET quando as duas estiverem
instaladas); o mesmo nome é o `generator.name` do `manifest.json`. Execução sem instalar:
`npx code-brain-angular <path>`. Repositório: `github.com/blogdoft/code-brain-angular` (espelho
do Forgejo).

O `package.json` declara `"publishConfig": { "access": "public" }` e `repository` apontando para o
GitHub (exigência da *provenance* e do *Trusted Publishing* do npm). A versão no `package.json` é
`0.0.0-local` e nunca é editada à mão: vem da tag `vX.Y.Z` (mesma regra do `code-csharp-ciir`).
CI e publicação: `.specs/02-ci-e-publicacao.md`.

---

# 3. Princípios arquiteturais

Os mesmos do `code-csharp-ciir` (SOLID, KISS, YAGNI, hexagonal, streaming). Interfaces só em
fronteiras reais. Nenhuma regra de análise no CLI.

## 3.1 Estrutura

```text
src/
  core/            modelo CIIR, identidade, hashing, embeddingText (sem typescript/@angular)
  application/     portas + caso de uso AnalyzeInputHandler, resolução de input, descoberta de projetos
  typescript/      ÚNICO módulo que importa `typescript` e `@angular/compiler`
    angular/       decorators, template, rotas, DI, signals
  configuration/   package.json / angular.json → configuration(+_key); *.yaml|*.yml → file
  serialization/   writer JSONL, manifest.json, analysis-report.json, ciir.schema.json
  indexer-client/  upload para o code-ciir-indexer (--send)
  cli/             composition root, parsing de argumentos, splash, progresso, exit codes
tests/             espelha src/ um-para-um
fixtures/          workspace Angular de exemplo usado pelos testes de integração
schemas/           ciir.schema.json (contrato — cópia literal do code-csharp-ciir)
```

Um teste de arquitetura falha se `src/core` ou `src/application` importarem `typescript` ou
`@angular/*`.

## 3.2 Stack

* **Node.js ≥ 20**, TypeScript, ESM.
* **TypeScript Compiler API 6.0.x** (`typescript`) — o equivalente do Roslyn aqui: syntax tree +
  `TypeChecker` (semantic model). *Decisão registrada:* o TypeScript 7 (port nativo em Go) só
  expõe uma API `unstable/*`; o 6.0 é a última linha com Compiler API JS estável e é a mesma versão
  que o Angular 22 usa.
* **`@angular/compiler`** — `parseTemplate` para templates (inline e `templateUrl`).
* `commander` (CLI), `jsonc-parser` (angular.json/tsconfig com comentários).
* Testes: **Vitest** + **Ajv** (validação contra o JSON Schema).
* Somente bibliotecas livres/open-source, na versão mais recente compatível.

---

# 4. Entrada e descoberta de projetos

`<path>` pode ser:

| Entrada | Tratamento | `manifest.input.type` |
|---|---|---|
| `angular.json` | todos os projetos do workspace | `workspace` |
| `tsconfig*.json` / `jsconfig.json` / `package.json` | aquele projeto | `project` |
| diretório | varredura recursiva | `directory` |

Na varredura de diretório são ignorados: `node_modules/`, `dist/`, `build/`, `out/`, `coverage/`,
`.angular/`, `.git/`, `.nx/`, `.next/`, `tmp/`.

Regras (mesmo espírito do C# com solution × csproj):

1. Cada `angular.json` encontrado contribui um projeto por entrada de `projects` (nome = chave,
   raiz = `root`, fontes = `sourceRoot` ou `<root>/src`, tsconfig =
   `architect.build.options.tsConfig` → `<root>/tsconfig.app.json` / `tsconfig.lib.json` →
   `tsconfig.json` do workspace).
2. Diretórios com `tsconfig.json`/`jsconfig.json`/`package.json` que **não** estejam dentro da raiz
   de um projeto já reivindicado por um `angular.json` viram projetos genéricos TS/JS (nome =
   `name` do `package.json`, senão o nome do diretório). Um `package.json` e um `tsconfig.json` no
   mesmo diretório são **um** projeto.
3. A identidade do projeto é o caminho absoluto normalizado da sua raiz de fontes; nenhum projeto
   é analisado duas vezes. Projetos são processados em ordem de nome.

## 4.1 Arquivos de um projeto

* `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` sob a raiz de fontes, excluindo os
  diretórios da seção 4 e `*.d.ts`.
* **Testes** (`*.spec.*`, `*.test.*`, `*.cy.*`, diretórios `cypress/`, `e2e/`, `__tests__/`) são
  ignorados por padrão; `--include-tests` os inclui. Em Angular, specs vivem ao lado do código e
  seus `describe/it` não declaram entidades — incluí-los por padrão só adicionaria ruído.
* **Código gerado** é ignorado e contabilizado em `analysis-report.documents.ignored`:
  `*.generated.*`, `*.g.ts`, `*.min.js`, e arquivos cujo cabeçalho contenha `<auto-generated` ou
  `@generated`.
* O `Program` do TypeScript é criado com esses arquivos como `rootNames` e as `compilerOptions`
  do tsconfig do projeto (respeitando `extends` e `paths`). Sem tsconfig: `allowJs`, `ES2022`,
  `moduleResolution: bundler`.

## 4.2 Pré-requisito

As dependências do projeto analisado precisam estar instaladas (`npm install`/`npm ci`). Sem
`node_modules`, imports de pacotes não resolvem e as relações correspondentes ficam
`unresolved`. A ferramenta não instala nada.

---

# 5. Mapeamento TypeScript → CIIR

`language` = `typescript` (`.ts/.tsx/.mts/.cts`) ou `javascript` (demais), por arquivo.
`project` = nome do projeto descoberto.

## 5.1 Nomes

TypeScript não tem namespaces globais como C#/Java: o "container" natural de uma declaração é o
**módulo** (arquivo). Os nomes seguem a convenção `{caminho}#{símbolo}` já usada pelo CIIR para
`configuration_key`:

| Entidade | `qualifiedName` | exemplo |
|---|---|---|
| módulo | caminho relativo à raiz do projeto, sem extensão | `src/app/core/auth.service` |
| declaração de topo | `<módulo>#<Nome>` | `src/app/core/auth.service#AuthService` |
| membro | `<módulo>#<Tipo>.<membro>` | `src/app/core/auth.service#AuthService.login` |
| declaração global (script, não-módulo) | `<Nome>` | `Window` |
| símbolo de pacote (`node_modules`) | `<pacote>#<Tipo>.<membro>` | `@angular/common#HttpClient.get` |
| símbolo da lib padrão (`lib.*.d.ts`) | `<Tipo>.<membro>` | `Array.map`, `Console.log` |

Os caminhos de módulo são relativos à **raiz do projeto** (não à raiz da análise), para que a
identidade não mude conforme o diretório de onde a análise é invocada. `source.path` continua
relativo à raiz da análise.

`canonicalName` = `qualifiedName`, acrescido de `(<tipos dos parâmetros>)` para
métodos/construtores/funções (ex.: `…#AuthService.login(string,string)`). Tipos de parâmetro vêm
do `TypeChecker` (`typeToString`, sem truncamento; literais de objeto anônimos viram `{...}`).

## 5.2 Kinds

| TypeScript | `kind` | detalhes |
|---|---|---|
| projeto | `project` | |
| módulo (arquivo) / `namespace X {}` | `namespace` | ver 5.3 |
| `class` | `type` (`class`) | `abstract` → modifier |
| `interface` | `type` (`interface`) | |
| `enum` / `const enum` | `type` (`enum`) | membros → `field` |
| `type X = (…) => …` | `type` (`delegate`) | |
| `type X = …` (demais) | `type` (`unknown`) | `extensions.typescript.declarationKind = "type_alias"` |
| método de classe / assinatura de método de interface | `method` | |
| `constructor` | `constructor` | |
| `get`/`set` | `property` | `get` + `set` do mesmo nome = **um** documento (`hasGetter`/`hasSetter`) |
| propriedade de interface | `property` | `hasSetter = !readonly` |
| propriedade de classe / *parameter property* do construtor | `field` | |
| `@Output()` / `output()` / `outputFromObservable()` | `event` | outputs do Angular são eventos |
| `function f()` de topo / `const f = () => …` / `const f = function…` | `function` | com bloco `method` (parâmetros/retorno) |
| `const`/`let`/`var` de topo (demais) | `field` | |

**Uma entidade semântica = um documento**: overloads de TS são o mesmo símbolo (uma única
implementação), e *declaration merging* (interface declarada duas vezes) também. Declarações
adicionais vão para `additionalSourceLocations` (análogo a `partial` do C#). A declaração primária
é a que tem corpo (implementação); se nenhuma tiver, a primeira.

## 5.3 Documento de módulo

Cada arquivo gera um documento `namespace` (nome = nome do arquivo sem extensão). Instruções de
topo que **não** são declarações (ex.: `bootstrapApplication(App, appConfig)` em `main.ts`) têm
suas relações e condições anexadas ao documento do módulo — é o único lugar onde esse fato cabe.

## 5.4 Acessibilidade e modificadores

* Membros de classe: `private`/`protected`/`public` explícitos; `#campo` → `private`; sem
  modificador → `public`. Membros de interface e de enum → `public`.
* Declarações de topo: `export` → `public`; não exportadas → `internal` (visíveis só no módulo).
* Modificadores mapeados: `const` (variável `const`, `const enum`), `static`, `readonly`,
  `declare` → `extern`, `abstract`, `override`, `async`; ordem canônica igual à do C#.

## 5.5 Documentação

JSDoc/TSDoc (`/** … */`): `format` = `tsdoc` em arquivos TypeScript, `jsdoc` em JavaScript. O
texto principal → `summary`; `@remarks` → `remarks`; `@param` → `parameters`; `@returns`/`@return`
→ `returns`; `@throws {Tipo} desc` → `exceptions`.

## 5.6 Comentários

Comentários `//` e `/* */` dentro do span da declaração (excluindo JSDoc `/** */`), com a mesma
classificação por marcador do C# (`TODO`, `FIXME`, `WARNING`, `NOTE`).

## 5.7 Relações

Todas resolvidas pelo `TypeChecker` (`getSymbolAtLocation`, aliases de import seguidos até a
declaração), nunca pelo texto:

| Relação | Origem |
|---|---|
| `inherits` | `class A extends B` |
| `implements` | `class A implements I`; `interface I extends J` (igual ao C#, onde interfaces base aparecem como `implements`) |
| `overrides` | membro de classe cujo nome existe na classe base (em TS todo método é sobrescrevível) |
| `calls` | `CallExpression` cujo alvo é método/função. Chamar um campo/propriedade (ex.: ler um signal `this.count()`) gera `reads` do campo, não `calls` |
| `constructs` | `new X()` → alvo é o **tipo** `X` |
| `reads` / `writes` | acesso a propriedade/campo/accessor/variável de módulo/membro de enum; `writes` quando é alvo de atribuição (`=`, compostas, `++/--`). Parâmetros e variáveis locais não geram relação. O receptor de uma chamada também gera `reads` (mesma regra do C#) |
| `throws` | `throw new X()` → `X`; `throw expr` → tipo estático de `expr` |
| `catches` | **não produzido**: `catch` em TS não declara tipo |

Relações também são extraídas de **inicializadores de campos e variáveis** (diferente do C# v1),
porque em Angular é ali que vivem `inject(...)`, `signal(...)`, `computed(...)`, `input()` etc.

### 5.7.1 Resolução

| Declaração do alvo | `status` / `origin` |
|---|---|
| arquivo do próprio projeto | `resolved` / `project` (+ `target.id`) |
| arquivo de outro projeto desta execução | `resolved` / `solution` (+ `target.id`) |
| `lib.*.d.ts` do TypeScript | `external` / `framework` |
| `node_modules/@types/node` | `external` / `runtime` |
| demais `node_modules` | `external` / `dependency` |
| arquivo fora de qualquer projeto analisado | `external` / `unknown` |
| receptor de tipo `any` | `dynamic` / `unknown` |
| sem símbolo | `unresolved` / `unknown` (com `reason`); `target.symbol` = texto da expressão |

`target.id` só é preenchido quando o alvo é `resolved` **e** o kind do alvo é um dos que este
gerador emite (a mesma função de classificação decide as duas coisas).

## 5.8 Condições

`if`, `else_if`, `guard` (if sem else cujo corpo é um único `return`/`throw`/`continue`/`break`),
`switch`, `conditional_expression` (`?:`), `while`, `do_while`, `for`, `foreach` (`for…of`,
`for…in`; `expression` = expressão iterada). `reads` lista as propriedades/campos lidos na
expressão.

## 5.9 Control flow

Sem CFG na Compiler API — mesma aproximação documentada do gerador Java:

* `cyclomaticComplexity` = 1 + nº de (`if`, `?:`, `case` não-default, `for`, `for…of`, `for…in`,
  `while`, `do`, `catch`, `&&`, `||`, `??`, `&&=`, `||=`, `??=`);
* `basicBlockCount` = pontos de decisão + 1;
* funções aninhadas (arrow functions, callbacks) **não** entram na contagem do método que as
  contém (como no CFG do Roslyn, em que lambdas têm grafo próprio).

## 5.10 Tipos de retorno

`returnType` = tipo de retorno da assinatura pelo `TypeChecker` (inclusive `void`).
`embeddingReturnType` só é preenchido ao desembrulhar `Promise<T>` → `T` com `T` não-`void`
(análogo ao `Task<T>` do C#); nos demais casos a seção `Returns` usa `returnType` — exatamente o
comportamento observado no gerador C#, que emite `Returns: System.Void`. `Observable<T>` **não** é
desembrulhado: é um fluxo, não um valor único.

---

# 6. Angular

Detectado por decorators/funções importados de `@angular/*` (resolvidos pelo `TypeChecker`, não
pelo nome). Tudo o que é específico de Angular fica em `extensions.angular` (o schema permite
`additionalProperties` em `extensions`), nunca em propriedades novas de topo.

## 6.1 Artefatos (documento `type`)

| Decorator | `extensions.angular.artifact` | campos |
|---|---|---|
| `@Component` | `component` | `selector`, `standalone`, `imports`, `providers`, `changeDetection`, `template` (6.3), `styleUrls` |
| `@Directive` | `directive` | `selector`, `standalone`, `exportAs`, `providers` |
| `@Pipe` | `pipe` | `pipeName`, `standalone`, `pure` |
| `@Injectable` | `service` | `providedIn` |
| `@NgModule` | `module` | `declarations`, `imports`, `exports`, `providers`, `bootstrap` |

Referências a classes (`imports`, `providers`, `declarations`…) são resolvidas para
`qualifiedName`. Valores literais (selector, providedIn) são copiados literalmente.

Além disso:

* `inputs`: `@Input()` e `input()`/`input.required()`/`model()` — `{ name, alias?, required, signal }`;
* `outputs`: `@Output()`, `output()`, `outputFromObservable()`, `model()` — `{ name, alias? }`;
* `injects`: tipos injetados via parâmetros do construtor e via `inject(X)` em qualquer ponto da
  classe — lista de `qualifiedName`;
* `lifecycleHooks`: hooks implementados (`ngOnInit`, `ngOnDestroy`, …).

Campos com signals recebem `extensions.angular.signal` = `signal` | `computed` | `input` |
`model` | `output` | `linkedSignal` | `resource` | `viewChild` | `viewChildren` |
`contentChild` | `contentChildren`.

Regra Angular de escrita: chamar `.set(...)`/`.update(...)` em um campo cujo tipo é
`WritableSignal`/`ModelSignal` gera, além do `calls`, um `writes` do campo (o signal é o estado
escrito).

## 6.2 Funções Angular

`const x: CanActivateFn = …` (e `CanActivateChildFn`, `CanDeactivateFn`, `CanMatchFn`,
`ResolveFn`, `HttpInterceptorFn`) → `extensions.angular.artifact` = `guard` | `resolver` |
`interceptor`.

## 6.3 Templates

`template` inline e `templateUrl` são lidos e processados com `parseTemplate` do
`@angular/compiler`. No documento `type` do componente:

* **relações** `calls`/`reads`/`writes` para membros **do próprio componente** referenciados no
  template (`(click)="save()"` → `calls …#Comp.save()`; `{{ title }}` → `reads …#Comp.title`;
  `[(ngModel)]="name"` e `x = 1` em handlers → `writes`). Em templates inline a `location` aponta
  para o arquivo `.ts`; com `templateUrl` a `location` é omitida (o schema exige que `range` seja
  do mesmo arquivo do documento);
* `extensions.angular.template`: `{ path?, hash, usedComponents, usedDirectives, usedPipes,
  unresolvedElements }` — seletores de elemento/atributo são casados contra os `selector`s dos
  componentes/diretivas **de todos os projetos da execução**, pipes contra `@Pipe({name})`.
  Elementos com hífen que não casam com nada vão para `unresolvedElements` (ex.: componentes de
  bibliotecas externas).

## 6.4 Rotas

Variável cujo tipo declarado é `Routes`/`Route[]` (de `@angular/router`) recebe
`extensions.angular.routes`: lista achatada `{ path, component?, loadComponent?, loadChildren?,
redirectTo?, canActivate?, canMatch?, resolve?, title? }` com o caminho completo (pais + filhos).
`component` e alvos de `loadComponent: () => import('./x').then(m => m.X)` são resolvidos para
`qualifiedName`.

## 6.5 HTTP

Chamadas a `HttpClient.get|post|put|patch|delete|head|options|request` registram, no documento do
método, `extensions.angular.httpCalls: [{ method, url }]`, onde `url` é o **texto literal** do
argumento (fato observável — não se tenta avaliar a string). Isso permite ligar o front aos
endpoints do backend no grafo do code-brain.

---

# 7. Configuração e arquivos

Igual ao `Ciir.Configuration` do C#, trocando `appsettings*.json` pelos equivalentes do ecossistema
JS, sob a raiz de análise (mesmas exclusões de diretório):

* `package.json` e `angular.json` → um `configuration` + um `configuration_key` por caminho de
  chave achatado (separador `:`, índices numéricos em arrays). **Valores nunca são capturados**,
  só `valueType` — mesma garantia de privacidade.
* `*.yaml` / `*.yml` → `file` (caminho, hash, tamanho).
* `language` = `json` / `yaml`; `project` = `Configuration`.

---

# 8. `embeddingText`

Estratégia `semantic-v1` do C#, com a mesma ordem de seções, mais uma seção **opcional**
`Framework`, logo após `Container`, emitida só para artefatos Angular:

```text
Entity: type
Qualified name: src/app/login/login.component#LoginComponent
Container: src/app/login/login.component
Framework: Angular component
Selector: app-login
Injects:
- src/app/core/auth.service#AuthService
Template uses:
- src/app/shared/button.component#ButtonComponent
Documentation: …
…
```

Para rotas: `Routes:` + `- /login -> …#LoginComponent`. Para chamadas HTTP: `HTTP:` +
`- GET '/api/projects'`.

A política de ruído (`TypeScriptNoiseEmbeddingTextPolicy`, um único componente testável) exclui do
`embeddingText` (não das `relations`) chamadas extremamente genéricas: `Console.*`, métodos comuns
de `Array`/`String`/`Object`/`JSON`/`Math`/`Promise`, `@angular/core#inject|signal|computed|input|output`
e `Observable.pipe`. Comentários só entram com marcador (TODO/FIXME/WARNING/NOTE).

---

# 9. Saída e contrato

Idêntica ao C#: `ciir.jsonl` (streaming, um registro por linha, gravado progressivamente),
`ciir.schema.json`, `manifest.json` (`generator.name = "code-brain-angular"`), `analysis-report.json`
(inclui até 200 relações não resolvidas com motivo, e a contagem total).

`schemaVersion` = `1.2`. Identidade: `sha256(language|project|kind|canonicalName)`. Hashes:
`source.hash` = SHA-256 do texto exato do span; `embeddingTextHash` sobre o texto exato.

Determinismo: projetos por nome, arquivos por caminho, membros por (constructor, method, property,
field, event; nome; canonicalName), modificadores em ordem canônica. Duas execuções sobre o mesmo
código produzem `ciir.jsonl` byte-idênticos.

---

# 10. CLI

| Opção | Significado |
|---|---|
| `--output <dir>` | diretório de saída (padrão `./ciir-output`) |
| `--verbose` | log detalhado em stderr |
| `--no-progress` | sem progresso |
| `--no-banner` | sem splash (também `CIIR_NOLOGO=1|true`) |
| `--include-source` | inclui `source.text` |
| `--include-tests` | analisa arquivos de teste (4.1) |
| `--fail-on-error` | exit ≠ 0 se algum projeto falhar |
| `-s`, `--send [<base-url>]` | envia `ciir.jsonl` ao code-ciir-indexer (mesmo contrato da spec 03 do C#; `CIIR_BASE_URL` como fallback) |
| `-pi`, `--projectId <guid>` | obrigatório com `--send` |
| `-ci`, `--clientId`, `-cs`, `--clientSecret` | client credentials (via `POST {base}/api/indexer/auth/token`) |
| `-t`, `--token <jwt>` | Bearer direto (vence client credentials) |
| `--insecure` | não valida TLS (aviso em stderr) |

Exit codes: `0` sucesso, `1` falha de projeto com `--fail-on-error`, `2` argumentos/entrada
inválidos, `3` falha ao gravar saída, `4` ambiente incapaz (Node < 20), `5` análise ok mas envio
falhou, `130` cancelado (Ctrl+C).

Splash (banner ASCII, link do blog, pré-requisitos) em toda análise; nunca em `--help`/`--version`.
Ctrl+C cancela graciosamente (writer fecha o arquivo).

---

# 11. Testes

* `core`: identidade, hashing, ordem de modificadores, `embeddingText`.
* `application`: resolução de input, descoberta/deduplicação, orquestração com portas falsas,
  teste de fronteira arquitetural.
* `typescript`: pipeline real contra `fixtures/basic-angular-app` (workspace com app + biblioteca):
  componentes, template, DI, signals, rotas, HTTP, relações `project`/`solution`/`external`,
  condições, control flow, documentação; **todo registro validado contra o schema**; determinismo.
* `configuration`: achatamento de chaves e garantia de não vazar valores.
* `serialization`: forma do JSONL (omissão de vazios, ordem de propriedades).
* `indexer-client`: servidor HTTP falso local (multipart, ordem dos campos, token).
* `cli`: subprocesso real (exit codes, splash, `--help`).

# 12. Fora de escopo (YAGNI, v1)

Interface visual; watch mode; análise de estilos (CSS/SCSS); resolução de valores de strings de
URL; frameworks além de Angular (React/Vue podem virar módulos irmãos de `typescript/angular/`);
CFG completo; `catches`.

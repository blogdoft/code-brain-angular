# CIIR — TypeScript/Angular generator notes

The meaning of every CIIR concept is defined by the reference specification in
`code-csharp-ciir/docs/ciir-specification.md`, and the formal contract by
[`schemas/ciir.schema.json`](../schemas/ciir.schema.json) (identical copy, schema 1.2). This
document only records how TypeScript/JavaScript and Angular are mapped onto that contract, and
where this generator deliberately differs.

## Names

TypeScript's natural container is the **module** (file), so names follow the `{path}#{symbol}`
convention CIIR already uses for `configuration_key`:

| Entity | `qualifiedName` |
|---|---|
| module | `src/app/orders/order.service` (relative to the project root, no extension) |
| top-level declaration | `src/app/orders/order.service#OrderService` |
| member | `src/app/orders/order.service#OrderService.pay` |
| npm package symbol | `@angular/common#HttpClient.get` |
| TypeScript lib / global | `Array.map`, `Console.log` |

`canonicalName` appends `(paramTypes)` for methods, constructors and functions. TypeScript
overloads are one symbol and therefore one document; extra signatures, the other half of a get/set
pair and merged declarations go to `additionalSourceLocations`.

## Kinds

`project`, `namespace` (module files and `namespace X {}`), `type` (`class`, `interface`, `enum`,
`delegate` for function type aliases, `unknown` + `extensions.typescript.declarationKind =
"type_alias"` for other aliases), `method`, `constructor`, `property` (get/set accessors, interface
properties), `field` (class properties, constructor parameter properties, enum members, top-level
variables), `event` (Angular outputs), `function` (top-level functions and function-valued
variables). Top-level statements that declare nothing attach their relations to the module
document.

## Relations and resolution

Resolved through the `TypeChecker`. `resolved/project` and `resolved/solution` (another project of
the same run) carry `target.id`; `lib.*.d.ts` → `external/framework`; `@types/node` →
`external/runtime`; other `node_modules` → `external/dependency`; calls on an `any` receiver →
`dynamic`. Differences from the C# generator:

- `catches` is never produced (TypeScript `catch` clauses have no type).
- Field/variable **initializers are analyzed** (Angular's `inject()`, `signal()`, `computed()`,
  `input()` live there).
- Invoking a field (e.g. reading a signal, `this.count()`) is a `reads` of the field, not a
  `calls`. Angular rule: `.set()`/`.update()` on a `WritableSignal`/`ModelSignal` field also
  records `writes` of that field.
- `overrides`: any class member whose name exists on the base class (every TS method is
  overridable).
- Interface `extends` is recorded as `implements`, as the C# generator does for base interfaces.

## Control flow

No CFG API exists in the TypeScript compiler; the same documented approximation as the Java
generator is used: complexity = 1 + decision points (`if`, `?:`, non-default `case`, loops,
`catch`, `&&`, `||`, `??` and their assignment forms), `basicBlockCount` = decision points + 1.
Nested functions are not counted in their enclosing entity.

## Angular (`extensions.angular`)

- Types: `artifact` (`component`, `directive`, `pipe`, `service`, `module`), `selector`,
  `standalone` (only when explicit), `imports`/`providers`/`declarations`/... resolved to qualified
  names, `inputs`, `outputs`, `injects`, `lifecycleHooks`, `styleUrls`, `template`.
- Templates are parsed with `@angular/compiler`. Expressions referring to the component's own
  members become `calls`/`reads`/`writes` relations on the component's `type` document (with a
  `location` only for inline templates, since a range must be in the document's own file).
  `template.usedComponents`/`usedDirectives`/`usedPipes` are matched against every declarable of the
  run by selector/pipe name; unmatched custom elements are listed in `unresolvedElements`
  (typically third-party components).
- Fields: `signal` (`signal`, `computed`, `input`, `model`, `output`, `resource`, `viewChild`, ...).
- Top-level variables: `artifact` `guard` / `resolver` / `interceptor` / `application_config`;
  `routes` with a flattened `routes` list (full paths, resolved components and lazy targets,
  guards).
- Methods/functions: `httpCalls` — `HttpClient` verb and the **literal** URL expression text.

## embeddingText

`semantic-v1`, same section order as C#, plus an optional `Framework` block right after
`Container` for Angular facts (artifact, selector, injects, inputs, outputs, template usage, routes,
HTTP calls). The noise policy (`TypeScriptNoiseEmbeddingTextPolicy`) drops generic calls
(`Console.*`, common `Array`/`String`/`Object`/`JSON`/`Math`/`Promise` members, Angular
DI/signal factories, `Observable.pipe`) from the text only — they remain in `relations`.

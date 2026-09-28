import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { CiirDocument, CiirRelation } from '../../src/core/model.js';
import {
  analyze,
  angularOf,
  byQualifiedName,
  FIXTURE,
  readJson,
  schemaValidator,
  type AnalysisRun,
} from '../helpers.js';

let run: AnalysisRun;
let docs: CiirDocument[];

const relationsOf = (document: CiirDocument, kind: CiirRelation['kind']): CiirRelation[] =>
  (document.relations ?? []).filter((relation) => relation.kind === kind);
const targetsOf = (document: CiirDocument, kind: CiirRelation['kind']): string[] =>
  relationsOf(document, kind).map((relation) => relation.target.symbol);

beforeAll(async () => {
  run = await analyze(FIXTURE);
  docs = run.documents;
});

describe('contract', () => {
  it('produces only schema-valid documents', () => {
    const validate = schemaValidator();
    const invalid = docs
      .map((d) => ({ name: d.symbol.canonicalName, errors: validate(d) }))
      .filter((r) => r.errors.length > 0);
    expect(invalid).toEqual([]);
  });

  it('gives every document a unique id and the embeddingText hash of its exact text', () => {
    expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length);
    for (const document of docs) {
      expect(document.embeddingTextStrategy).toBe('semantic-v1');
      expect(document.embeddingTextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('is deterministic: two runs produce byte-identical ciir.jsonl', async () => {
    const second = await analyze(FIXTURE);
    expect(second.raw).toBe(run.raw);
  });

  it('never leaks absolute paths into documents', () => {
    expect(run.raw).not.toContain(FIXTURE);
  });

  it('resolves every relation of the fixture', () => {
    const unresolved = docs.flatMap((d) =>
      (d.relations ?? []).filter((r) => r.resolution.status === 'unresolved'),
    );
    expect(unresolved).toEqual([]);
  });

  it('writes the manifest with the generator and both projects', () => {
    const manifest = readJson(join(run.outputDirectory, 'manifest.json'));
    expect(manifest).toMatchObject({
      generator: { name: 'code-brain-angular' },
      input: { type: 'directory' },
      projects: [
        { name: 'demo-app', kind: 'angular', path: 'src', config: 'tsconfig.app.json' },
        { name: 'shared-lib', kind: 'angular', path: 'projects/shared-lib/src' },
      ],
    });
  });
});

describe('files and projects', () => {
  it('emits one project document per project and a namespace per module', () => {
    expect(docs.filter((d) => d.kind === 'project').map((d) => d.symbol.name)).toEqual([
      'demo-app',
      'shared-lib',
    ]);
    expect(byQualifiedName(docs, 'src/main', 'namespace').source?.path).toBe('src/main.ts');
  });

  it('skips spec and generated files by default (counted as ignored)', () => {
    expect(docs.some((d) => d.source?.path.endsWith('.spec.ts'))).toBe(false);
    expect(docs.some((d) => d.source?.path.includes('api.generated'))).toBe(false);
    expect(readJson(join(run.outputDirectory, 'analysis-report.json'))).toMatchObject({
      documents: { ignored: 2 },
    });
  });

  it('includes spec files with includeTests', async () => {
    const withTests = await analyze(FIXTURE, { includeTests: true });
    expect(
      withTests.documents.some((d) => d.source?.path === 'src/app/orders/order-list.component.spec.ts'),
    ).toBe(true);
  });

  it('attaches top-level statements to the module document', () => {
    const main = byQualifiedName(docs, 'src/main', 'namespace');
    expect(targetsOf(main, 'calls')).toContain(
      '@angular/platform-browser#bootstrapApplication(Type<unknown>,ApplicationConfig | undefined,BootstrapContext | undefined)',
    );
    expect(targetsOf(main, 'reads')).toContain('src/app/app.config#appConfig');
  });

  it('analyzes JavaScript files with jsdoc documentation', () => {
    const double = byQualifiedName(docs, 'src/legacy#double');
    expect(double).toMatchObject({
      kind: 'function',
      language: 'javascript',
      documentation: { format: 'jsdoc' },
    });
  });

  it('includes the literal source only with includeSource', async () => {
    expect(docs.every((d) => d.source?.text === undefined)).toBe(true);
    const withSource = await analyze(FIXTURE, { includeSource: true });
    expect(byQualifiedName(withSource.documents, 'src/lib/money#formatMoney').source?.text).toContain(
      'export function formatMoney',
    );
  });
});

describe('types and members', () => {
  it('maps classes, interfaces, enums and type aliases', () => {
    expect(byQualifiedName(docs, 'src/app/shared/base.component#BaseComponent').type).toEqual({
      typeKind: 'class',
      accessibility: 'public',
      modifiers: ['abstract'],
    });
    expect(byQualifiedName(docs, 'src/app/orders/order.model#Order').type?.typeKind).toBe('interface');
    expect(byQualifiedName(docs, 'src/app/orders/order.model#OrderStatus', 'type').type?.typeKind).toBe(
      'enum',
    );
    expect(byQualifiedName(docs, 'src/app/orders/order.model#OrderFilter').type?.typeKind).toBe('delegate');
    expect(byQualifiedName(docs, 'src/app/orders/order.model#OrderId')).toMatchObject({
      type: { typeKind: 'unknown' },
      extensions: { typescript: { declarationKind: 'type_alias' } },
    });
  });

  it('maps interface properties, enum members, accessors and fields', () => {
    expect(byQualifiedName(docs, 'src/app/orders/order.model#Order.id').property).toMatchObject({
      type: 'number',
      hasGetter: true,
      hasSetter: false,
    });
    expect(byQualifiedName(docs, 'src/app/orders/order.model#OrderStatus.Paid')).toMatchObject({
      kind: 'field',
      field: { type: 'src/app/orders/order.model#OrderStatus' },
    });
    expect(byQualifiedName(docs, 'src/app/core/auth.service#AuthService.loggedIn').property).toMatchObject({
      hasGetter: true,
      hasSetter: false,
    });
    expect(byQualifiedName(docs, 'src/app/core/auth.service#AuthService.session').property).toMatchObject({
      hasGetter: false,
      hasSetter: true,
    });
    expect(byQualifiedName(docs, 'src/app/core/auth.service#AuthService.token').field).toMatchObject({
      accessibility: 'private',
      type: 'string | undefined',
    });
  });

  it('turns constructor parameter properties into fields', () => {
    expect(
      byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent.service').field,
    ).toEqual({
      accessibility: 'private',
      modifiers: ['readonly'],
      type: 'OrderService',
    });
  });

  it('orders members canonically: constructor, methods, properties, fields, events', () => {
    const members = docs.filter(
      (d) => d.symbol.container === 'src/app/orders/order-list.component#OrderListComponent',
    );
    const kinds = members.map((d) => d.kind);
    expect(kinds.indexOf('constructor')).toBe(0);
    expect(kinds.lastIndexOf('method')).toBeLessThan(kinds.indexOf('field'));
    expect(kinds.lastIndexOf('field')).toBeLessThan(kinds.indexOf('event'));
  });

  it('describes methods: parameters, return type, unwrapped Promise, modifiers and TSDoc', () => {
    const pay = byQualifiedName(docs, 'src/app/orders/order.service#OrderService.pay');
    expect(pay.symbol.canonicalName).toBe('src/app/orders/order.service#OrderService.pay(Order)');
    expect(pay.method).toEqual({
      accessibility: 'public',
      modifiers: ['async'],
      parameters: [{ name: 'order', type: 'Order' }],
      returnType: 'Promise<Order>',
      embeddingReturnType: 'Order',
    });
    expect(pay.documentation).toEqual({
      format: 'tsdoc',
      source: 'declared',
      summary: 'Pays an order.',
      parameters: [{ name: 'order', description: 'The order to pay.' }],
      returns: 'The paid order.',
      exceptions: [{ type: 'InvalidOrderError', description: 'When the order total is not positive.' }],
    });
    expect(pay.comments).toEqual([
      expect.objectContaining({ kind: 'todo', text: 'TODO: retry transient failures.' }),
    ]);
  });

  it('extracts conditions and control-flow metrics', () => {
    const pay = byQualifiedName(docs, 'src/app/orders/order.service#OrderService.pay');
    expect(pay.conditions).toEqual([
      expect.objectContaining({
        kind: 'guard',
        expression: 'order.total <= 0',
        reads: ['src/app/orders/order.model#Order.total'],
      }),
    ]);
    expect(pay.controlFlow).toEqual({
      basicBlockCount: 2,
      cyclomaticComplexity: 2,
      hasBranches: true,
      hasLoops: false,
    });

    const label = byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent.totalLabel');
    expect(label.conditions?.map((c) => c.kind)).toEqual([
      'foreach',
      'conditional_expression',
      'conditional_expression',
    ]);
    // for-of + two ternaries + && = 4 decisions
    expect(label.controlFlow).toEqual({
      basicBlockCount: 5,
      cyclomaticComplexity: 5,
      hasBranches: true,
      hasLoops: true,
    });

    const transform = byQualifiedName(docs, 'src/app/orders/order-status.pipe#OrderStatusPipe.transform');
    expect(transform.conditions?.[0]).toMatchObject({ kind: 'switch', expression: 'status' });
  });
});

describe('relations', () => {
  it('records inherits/implements/overrides against resolved targets with ids', () => {
    const app = byQualifiedName(docs, 'src/app/app.component#AppComponent');
    const base = byQualifiedName(docs, 'src/app/shared/base.component#BaseComponent');
    expect(relationsOf(app, 'inherits')).toEqual([
      expect.objectContaining({
        target: { id: base.id, symbol: base.symbol.canonicalName },
        resolution: { status: 'resolved', origin: 'project' },
      }),
    ]);
    expect(
      relationsOf(
        byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent'),
        'implements',
      ),
    ).toEqual([
      expect.objectContaining({
        target: { symbol: '@angular/core#OnInit' },
        resolution: { status: 'external', origin: 'dependency' },
      }),
    ]);

    const title = byQualifiedName(docs, 'src/app/app.component#AppComponent.title');
    const baseTitle = byQualifiedName(docs, 'src/app/shared/base.component#BaseComponent.title');
    expect(relationsOf(title, 'overrides')).toEqual([
      expect.objectContaining({ target: { id: baseTitle.id, symbol: baseTitle.symbol.canonicalName } }),
    ]);
    expect(title.method?.modifiers).toEqual(['override']);
  });

  it('records calls, reads, writes, constructs and throws with ids matching the target documents', () => {
    const pay = byQualifiedName(docs, 'src/app/orders/order.service#OrderService.pay');
    const error = byQualifiedName(docs, 'src/app/orders/invalid-order.error#InvalidOrderError', 'type');
    expect(relationsOf(pay, 'throws')).toEqual([
      expect.objectContaining({ target: { id: error.id, symbol: error.symbol.canonicalName } }),
    ]);
    expect(targetsOf(pay, 'constructs')).toEqual([error.symbol.canonicalName]);
    expect(targetsOf(pay, 'writes')).toEqual(['src/app/orders/order.model#Order.status']);
    expect(targetsOf(pay, 'reads')).toEqual(
      expect.arrayContaining([
        'src/app/orders/order.service#OrderService.http',
        'src/app/orders/order.service#OrderService.baseUrl',
        'src/app/orders/order.model#OrderStatus.Paid',
      ]),
    );
    expect(
      relationsOf(pay, 'calls').map((r) => [
        r.target.symbol.split('(')[0],
        r.resolution.status,
        r.resolution.origin,
      ]),
    ).toEqual([
      ['rxjs#firstValueFrom', 'external', 'dependency'],
      ['@angular/common#HttpClient.post', 'external', 'dependency'],
    ]);

    const ids = new Set(docs.map((d) => d.id));
    for (const relation of docs.flatMap((d) => d.relations ?? [])) {
      if (relation.target.id) {
        expect(ids.has(relation.target.id), relation.target.symbol).toBe(true);
      }
    }
  });

  it('resolves another project of the same run as solution, with the target id', () => {
    const label = byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent.totalLabel');
    const format = byQualifiedName(docs, 'src/lib/money#formatMoney');
    expect(
      relationsOf(label, 'calls').find((r) => r.target.symbol === format.symbol.canonicalName),
    ).toMatchObject({
      target: { id: format.id },
      resolution: { status: 'resolved', origin: 'solution' },
    });
  });

  it('classifies TypeScript lib symbols as framework', () => {
    const format = byQualifiedName(docs, 'src/lib/money#formatMoney');
    expect(relationsOf(format, 'calls')).toEqual([
      expect.objectContaining({
        target: { symbol: 'Number.toFixed(number | undefined)' },
        resolution: { status: 'external', origin: 'framework' },
      }),
    ]);
  });

  it('treats invoking a signal as a read and set/update as a write of the signal field', () => {
    const select = byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent.select');
    expect(targetsOf(select, 'writes')).toEqual([
      'src/app/orders/order-list.component#OrderListComponent.selected',
    ]);
    const toggle = byQualifiedName(docs, 'src/app/app.component#AppComponent.toggle');
    expect(targetsOf(toggle, 'writes')).toEqual(['src/app/app.component#AppComponent.expanded']);
    const total = byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent.total');
    expect(targetsOf(total, 'reads')).toContain(
      'src/app/orders/order-list.component#OrderListComponent.orders',
    );
    expect(targetsOf(total, 'calls').some((t) => t.endsWith('.orders()'))).toBe(false);
  });
});

describe('Angular', () => {
  it('describes a component: selector, imports, template usage, DI, inputs/outputs and hooks', () => {
    const list = byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent');
    expect(angularOf(list)).toEqual({
      artifact: 'component',
      selector: 'app-order-list',
      imports: ['src/app/orders/order-status.pipe#OrderStatusPipe'],
      styleUrls: ['src/app/orders/order-list.component.css'],
      template: {
        path: 'src/app/orders/order-list.component.html',
        hash: expect.stringMatching(/^sha256:/),
        usedComponents: ['src/lib/badge.component#BadgeComponent'],
        usedPipes: ['src/app/orders/order-status.pipe#OrderStatusPipe'],
        unresolvedElements: ['vendor-widget'],
      },
      lifecycleHooks: ['ngOnInit'],
      inputs: [
        { name: 'heading', required: true, signal: true },
        { name: 'pageSize', alias: 'size', required: false, signal: true },
        { name: 'query', required: false, signal: true },
        { name: 'legacyMode', required: false, signal: false },
      ],
      outputs: [{ name: 'queryChange' }, { name: 'selectedChange' }, { name: 'cleared' }],
      injects: ['src/app/orders/order.service#OrderService'],
    });
  });

  it('links template expressions to the component members (no location for templateUrl)', () => {
    const list = byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent');
    const select = byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent.select');
    const templateCall = relationsOf(list, 'calls').find(
      (r) => r.target.symbol === select.symbol.canonicalName,
    );
    expect(templateCall).toEqual({
      kind: 'calls',
      target: { id: select.id, symbol: select.symbol.canonicalName },
      resolution: { status: 'resolved', origin: 'project' },
    });
    expect(targetsOf(list, 'reads')).toEqual(
      expect.arrayContaining([
        'src/app/orders/order-list.component#OrderListComponent.heading',
        'src/app/orders/order-list.component#OrderListComponent.orders',
        'src/app/orders/order-list.component#OrderListComponent.query',
      ]),
    );
    // `order` is an @for variable, not a component member.
    expect(targetsOf(list, 'reads').some((t) => t.endsWith('.order'))).toBe(false);
  });

  it('gives inline-template relations a location inside the .ts file', () => {
    const app = byQualifiedName(docs, 'src/app/app.component#AppComponent');
    const toggle = relationsOf(app, 'calls').find((r) => r.target.symbol.endsWith('#AppComponent.toggle()'));
    expect(toggle?.location).toMatchObject({ startLine: 13, endLine: 13 });
    expect(angularOf(app)['template']).toMatchObject({
      usedComponents: ['src/lib/badge.component#BadgeComponent'],
      usedDirectives: ['src/app/shared/highlight.directive#HighlightDirective'],
      unresolvedElements: ['router-outlet'],
    });
  });

  it('describes services, pipes and directives', () => {
    const service = byQualifiedName(docs, 'src/app/orders/order.service#OrderService');
    expect(angularOf(service)).toMatchObject({
      artifact: 'service',
      providedIn: 'root',
      injects: ['@angular/common#HttpClient'],
    });
    expect(
      angularOf(byQualifiedName(docs, 'src/app/orders/order-status.pipe#OrderStatusPipe')),
    ).toMatchObject({ artifact: 'pipe', pipeName: 'orderStatus' });
    expect(
      angularOf(byQualifiedName(docs, 'src/app/shared/highlight.directive#HighlightDirective')),
    ).toMatchObject({ artifact: 'directive', selector: '[appHighlight]' });
  });

  it('maps outputs to events and signal fields to their signal kind', () => {
    expect(
      byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent.selectedChange'),
    ).toMatchObject({ kind: 'event', event: { type: 'OutputEmitterRef<Order>' } });
    expect(byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent.cleared').kind).toBe(
      'event',
    );
    expect(
      angularOf(byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent.total')),
    ).toEqual({ signal: 'computed' });
    expect(
      angularOf(byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent.heading')),
    ).toEqual({ signal: 'input' });
  });

  it('flattens routes with resolved components, lazy targets and guards', () => {
    const routes = byQualifiedName(docs, 'src/app/app.routes#routes');
    expect(angularOf(routes)).toEqual({
      artifact: 'routes',
      routes: [
        { path: '/', component: 'src/app/orders/order-list.component#OrderListComponent', title: 'Orders' },
        { path: '/admin', canActivate: ['src/app/core/auth.guard#authGuard'] },
        {
          path: '/admin/reports',
          loadComponent: 'src/app/orders/order-report.component#OrderReportComponent',
        },
        { path: '/**', redirectTo: '' },
      ],
    });
    expect(routes.embeddingText).toContain(
      'Routes:\n- / -> src/app/orders/order-list.component#OrderListComponent',
    );
  });

  it('recognizes functional guards and the application config', () => {
    expect(angularOf(byQualifiedName(docs, 'src/app/core/auth.guard#authGuard'))).toEqual({
      artifact: 'guard',
    });
    expect(angularOf(byQualifiedName(docs, 'src/app/app.config#appConfig'))).toEqual({
      artifact: 'application_config',
    });
  });

  it('records HttpClient calls with the literal URL expression', () => {
    expect(angularOf(byQualifiedName(docs, 'src/app/orders/order.service#OrderService.load'))).toEqual({
      httpCalls: [{ method: 'GET', url: 'this.baseUrl' }],
    });
    expect(angularOf(byQualifiedName(docs, 'src/app/orders/order.service#OrderService.pay'))).toEqual({
      httpCalls: [{ method: 'POST', url: '`${this.baseUrl}/${order.id}/pay`' }],
    });
  });

  it('renders the Framework section and filters noise in embeddingText', () => {
    const list = byQualifiedName(docs, 'src/app/orders/order-list.component#OrderListComponent');
    expect(list.embeddingText).toContain(
      'Framework: Angular component\nSelector: app-order-list\nInjects:\n- src/app/orders/order.service#OrderService',
    );
    const service = byQualifiedName(docs, 'src/app/orders/order.service#OrderService.http');
    expect(targetsOf(service, 'calls')[0]).toMatch(/^@angular\/core#inject\(/);
    expect(service.embeddingText).not.toContain('Calls:');
  });
});

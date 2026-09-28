import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { BadgeComponent } from 'shared-lib';
import { BaseComponent } from './shared/base.component';
import { HighlightDirective } from './shared/highlight.directive';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, BadgeComponent, HighlightDirective],
  template: `
    <h1 appHighlight>{{ title() }}</h1>
    <lib-badge [label]="version()" />
    <button (click)="toggle()">Toggle</button>
    <router-outlet />
  `,
})
export class AppComponent extends BaseComponent {
  protected readonly version = signal('1.0.0');
  protected readonly expanded = signal(false);

  // NOTE: the title is shown in the browser tab as well.
  override title(): string {
    return 'Orders';
  }

  toggle(): void {
    this.expanded.update((value) => !value);
  }
}

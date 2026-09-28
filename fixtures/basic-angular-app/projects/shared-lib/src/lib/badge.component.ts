import { Component, input } from '@angular/core';

/** A small label shown next to totals. */
@Component({
  selector: 'lib-badge',
  template: `<span class="badge">{{ label() }}</span>`,
})
export class BadgeComponent {
  readonly label = input<string>('');
}

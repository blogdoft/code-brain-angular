import { Directive, ElementRef, inject } from '@angular/core';

@Directive({ selector: '[appHighlight]' })
export class HighlightDirective {
  private readonly element = inject(ElementRef);

  highlight(): void {
    this.element.nativeElement.style.background = 'yellow';
  }
}

/** Common behaviour of every page. */
export abstract class BaseComponent {
  abstract title(): string;

  describe(): string {
    return `Page: ${this.title()}`;
  }
}

import { Component, EventEmitter, Input, OnInit, Output, computed, input, model, output, signal } from '@angular/core';
import { formatMoney } from 'shared-lib';
import { Order } from './order.model';
import { OrderService } from './order.service';
import { OrderStatusPipe } from './order-status.pipe';

@Component({
  selector: 'app-order-list',
  imports: [OrderStatusPipe],
  templateUrl: './order-list.component.html',
  styleUrl: './order-list.component.css',
})
export class OrderListComponent implements OnInit {
  readonly heading = input.required<string>();
  readonly pageSize = input(20, { alias: 'size' });
  readonly query = model('');
  readonly selectedChange = output<Order>();
  @Input() legacyMode = false;
  @Output() readonly cleared = new EventEmitter<void>();

  protected readonly orders = signal<Order[]>([]);
  protected readonly selected = signal<Order | undefined>(undefined);
  protected readonly total = computed(() => this.orders().reduce((sum, order) => sum + order.total, 0));

  constructor(private readonly service: OrderService) {}

  ngOnInit(): void {
    this.service.load().subscribe((orders) => this.orders.set(orders));
  }

  select(order: Order): void {
    this.selected.set(order);
    this.selectedChange.emit(order);
  }

  totalLabel(): string {
    let count = 0;
    for (const order of this.orders()) {
      count += order.total > 100 ? 2 : 1;
    }
    return count > 0 && !this.legacyMode ? formatMoney(this.total()) : '-';
  }
}

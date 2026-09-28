import { Pipe, PipeTransform } from '@angular/core';
import { OrderStatus } from './order.model';

@Pipe({ name: 'orderStatus' })
export class OrderStatusPipe implements PipeTransform {
  transform(status: OrderStatus): string {
    switch (status) {
      case OrderStatus.Paid:
        return 'Paid';
      default:
        return 'Pending';
    }
  }
}

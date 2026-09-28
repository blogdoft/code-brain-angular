import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { InvalidOrderError } from './invalid-order.error';
import { Order, OrderStatus } from './order.model';

@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api/orders';

  load(): Observable<Order[]> {
    return this.http.get<Order[]>(this.baseUrl);
  }

  /**
   * Pays an order.
   * @param order - The order to pay.
   * @returns The paid order.
   * @throws {InvalidOrderError} When the order total is not positive.
   */
  async pay(order: Order): Promise<Order> {
    if (order.total <= 0) {
      throw new InvalidOrderError('Total must be positive.');
    }
    // TODO: retry transient failures.
    const paid = await firstValueFrom(this.http.post<Order>(`${this.baseUrl}/${order.id}/pay`, order));
    order.status = OrderStatus.Paid;
    return paid;
  }
}

export enum OrderStatus {
  Pending = 'pending',
  Paid = 'paid',
}

/** An order placed by a customer. */
export interface Order {
  readonly id: number;
  total: number;
  status: OrderStatus;
}

export type OrderFilter = (order: Order) => boolean;

export type OrderId = Order['id'];

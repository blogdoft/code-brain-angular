import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { OrderListComponent } from './orders/order-list.component';

export const routes: Routes = [
  { path: '', component: OrderListComponent, title: 'Orders' },
  {
    path: 'admin',
    canActivate: [authGuard],
    children: [
      { path: 'reports', loadComponent: () => import('./orders/order-report.component').then((m) => m.OrderReportComponent) },
    ],
  },
  { path: '**', redirectTo: '' },
];

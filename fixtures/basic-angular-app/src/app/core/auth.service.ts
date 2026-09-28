import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private token: string | undefined;

  get loggedIn(): boolean {
    return this.token !== undefined;
  }

  set session(value: string | undefined) {
    this.token = value;
  }

  isLoggedIn(): boolean {
    return this.loggedIn;
  }
}

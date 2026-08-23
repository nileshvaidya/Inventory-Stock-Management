import { describe, it, expect } from 'vitest';
import { validateSignupForm, validateSigninForm } from './validation.js';

describe('validateSignupForm', () => {
  it('accepts a valid form', () => {
    const { valid } = validateSignupForm({ name: 'Jane Doe', email: 'jane@example.com', password: 'secret1' });
    expect(valid).toBe(true);
  });

  it('rejects a missing name', () => {
    const { valid, errors } = validateSignupForm({ name: '', email: 'jane@example.com', password: 'secret1' });
    expect(valid).toBe(false);
    expect(errors.name).toBeTruthy();
  });

  it('rejects an invalid email', () => {
    const { valid, errors } = validateSignupForm({ name: 'Jane', email: 'not-an-email', password: 'secret1' });
    expect(valid).toBe(false);
    expect(errors.email).toBeTruthy();
  });

  it('rejects a short password', () => {
    const { valid, errors } = validateSignupForm({ name: 'Jane', email: 'jane@example.com', password: 'abc' });
    expect(valid).toBe(false);
    expect(errors.password).toBeTruthy();
  });
});

describe('validateSigninForm', () => {
  it('accepts a valid form', () => {
    const { valid } = validateSigninForm({ email: 'jane@example.com', password: 'secret1' });
    expect(valid).toBe(true);
  });

  it('rejects missing fields', () => {
    const { valid, errors } = validateSigninForm({ email: '', password: '' });
    expect(valid).toBe(false);
    expect(errors.email).toBeTruthy();
    expect(errors.password).toBeTruthy();
  });
});

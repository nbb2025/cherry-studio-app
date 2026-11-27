import type { HttpRequest, HttpResponse } from '@/backend/services/http';

import { IagentAccountRuntime, type IagentSession } from '../IagentAccountRuntime';
import { IagentClient } from '../IagentClient';

const session: IagentSession = {
  userId: 4,
  name: 'Test',
  accessToken: 'test-access-1',
  refreshToken: 'test-refresh-1',
};
const user = { id: 4, username: 'Test', email: 'test@example.test', balance: 2 };

function json(data: unknown, status = 200): HttpResponse<unknown> {
  return { data: { code: status === 200 ? 0 : status, data }, headers: {}, status };
}

function setup(request: (input: HttpRequest) => Promise<HttpResponse<unknown>>, signedIn = true) {
  const save = jest.fn();
  const account = new IagentAccountRuntime({
    client: new IagentClient(request),
    stored: signedIn ? session : null,
    locale: () => 'zh-CN',
    save,
  });
  return { account, save };
}

test('concurrent expired requests rotate once and retry with the new JWT', async () => {
  const request = jest
    .fn<Promise<HttpResponse<unknown>>, [HttpRequest]>()
    .mockImplementation(async ({ path, body, headers }) => {
      if (path === '/api/v1/auth/refresh') {
        expect(body).toEqual({ refresh_token: 'test-refresh-1' });
        return json({
          access_token: 'test-access-2',
          refresh_token: 'test-refresh-2',
          expires_in: 3600,
        });
      }
      return headers?.Authorization === 'Bearer test-access-2' ? json(user) : json(null, 401);
    });
  const { account, save } = setup(request);
  await expect(Promise.all([account.getUser(), account.getUser()])).resolves.toEqual([user, user]);
  expect(request.mock.calls.filter(([{ path }]) => path.endsWith('/auth/refresh'))).toHaveLength(1);
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: 4,
      accessToken: 'test-access-2',
      refreshToken: 'test-refresh-2',
    }),
  );
});

test('sign-in replaces the guest session in place and enables iAgent requests', async () => {
  const request = async () =>
    json({ access_token: 'test-access-1', refresh_token: 'test-refresh-1', user });
  const { account, save } = setup(request, false);
  const guest = account.catalogSignal;
  expect(account.getState().isSignedIn).toBe(false);
  await account.authenticate({ email: user.email, password: 'test-password' });
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ userId: 4 }));
  expect(guest.aborted).toBe(true);
  expect(account.getState()).toMatchObject({
    isSignedIn: true,
    iagentUserId: 4,
    needsSignIn: false,
  });
});

test('two-factor login keeps the session in guest mode until an authenticator code succeeds', async () => {
  const request = jest
    .fn<Promise<HttpResponse<unknown>>, [HttpRequest]>()
    .mockImplementation(async ({ path, body }) => {
      if (path.endsWith('/auth/login'))
        return json({ requires_2fa: true, temp_token: 'test-ticket' });
      expect(path).toMatch(/\/auth\/login\/2fa$/);
      expect(body).toMatchObject({ temp_token: 'test-ticket' });
      if ((body as { totp_code: string }).totp_code === '123456')
        return json({ access_token: 'test-access-1', user });
      return json(null, 400);
    });
  const { account, save } = setup(request, false);
  await expect(account.authenticate({ email: user.email, password: 'secret' })).resolves.toBe(
    'test-ticket',
  );
  expect(save).not.toHaveBeenCalled();
  expect(account.getState().isSignedIn).toBe(false);
  await expect(account.confirmTwoFactor('test-ticket', '654321')).rejects.toMatchObject({
    code: 'totp',
  });
  expect(save).not.toHaveBeenCalled();
  await expect(account.confirmTwoFactor('test-ticket', '123456')).resolves.toBeUndefined();
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ userId: 4 }));
  expect(account.getState().isSignedIn).toBe(true);
});

test('revoked refresh credentials cancel iAgent work and leave guest access available', async () => {
  const request = jest
    .fn<Promise<HttpResponse<unknown>>, [HttpRequest]>()
    .mockImplementation(async () => json(null, 401));
  const { account, save } = setup(request);
  const lifetime = account.signal;
  await expect(account.getUser()).rejects.toMatchObject({ code: 'session', status: 401 });
  expect(save).toHaveBeenCalledWith(null);
  expect(lifetime.aborted).toBe(true);
  expect(account.getState()).toMatchObject({ isSignedIn: false, needsSignIn: false });
  expect(account.catalogSignal.aborted).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
});

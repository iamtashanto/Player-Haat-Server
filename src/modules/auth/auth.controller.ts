import type { Request, Response } from "express";
import { z } from "zod";
import { authUser } from "../../middlewares/auth.js";
import { created, ok, valid } from "../../lib/http.js";
import { verifyAppleIdentityToken } from "../../lib/social/apple.js";
import { verifyGoogleIdToken } from "../../lib/social/google.js";
import * as account from "./account.service.js";
import * as auth from "./auth.service.js";
import type * as s from "./auth.schema.js";
import * as methods from "./methods.service.js";
import * as tokens from "./token.service.js";

type Body<T extends z.ZodType> = z.infer<T>;
const success = { success: true as const };
const ctxOf = (req: Request, deviceId?: string) => ({ deviceId, userAgent: req.get("user-agent") });

export async function register(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.registerBody>>(req);
  created(res, await auth.register(body, ctxOf(req, body.deviceId)));
}

export async function login(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.loginBody>>(req);
  ok(res, await auth.login(body, ctxOf(req, body.deviceId)));
}

export async function adminLogin(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.loginBody>>(req);
  ok(res, await auth.adminLogin(body, ctxOf(req, body.deviceId)));
}

export async function google(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.googleBody>>(req);
  const profile = await verifyGoogleIdToken(body.idToken);
  ok(res, await auth.socialLogin(profile, ctxOf(req, body.deviceId), { role: body.role }));
}

export async function apple(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.appleBody>>(req);
  const profile = await verifyAppleIdentityToken(body.identityToken, { nonce: body.nonce });
  ok(res, await auth.socialLogin(profile, ctxOf(req, body.deviceId), { fallbackName: body.name, role: body.role }));
}

export async function refresh(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.refreshBody>>(req);
  ok(res, await tokens.rotateRefreshToken(body.refreshToken, ctxOf(req, body.deviceId)));
}

export async function logout(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.logoutBody>>(req);
  await tokens.logout(body.refreshToken);
  ok(res, success);
}

export async function logoutAll(req: Request, res: Response) {
  await tokens.revokeAllForUser(authUser(req).userId);
  ok(res, success);
}

export async function verifyEmail(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.verifyEmailBody>>(req);
  ok(res, await auth.verifyEmail(body));
}

export async function resendVerification(req: Request, res: Response) {
  await auth.resendVerification(authUser(req).userId);
  ok(res, success);
}

export async function forgotPassword(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.forgotPasswordBody>>(req);
  await auth.forgotPassword(body);
  ok(res, success);
}

export async function resetPassword(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.resetPasswordBody>>(req);
  await auth.resetPassword(body);
  ok(res, success);
}

export async function setPassword(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.setPasswordBody>>(req);
  ok(res, await auth.setPassword(authUser(req).userId, body, ctxOf(req, body.deviceId)));
}

export async function listMethods(req: Request, res: Response) {
  ok(res, await methods.listMethods(authUser(req).userId));
}

export async function linkGoogle(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.linkGoogleBody>>(req);
  ok(res, await methods.linkProvider(authUser(req).userId, await verifyGoogleIdToken(body.idToken)));
}

export async function linkApple(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.linkAppleBody>>(req);
  const profile = await verifyAppleIdentityToken(body.identityToken, { nonce: body.nonce });
  ok(res, await methods.linkProvider(authUser(req).userId, profile));
}

export async function unlinkMethod(req: Request, res: Response) {
  const { params } = valid<unknown, Body<typeof s.providerParams>>(req);
  ok(res, await methods.unlinkProvider(authUser(req).userId, params.provider));
}

export async function deleteAccount(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.deleteAccountBody>>(req);
  await account.deleteAccount(authUser(req).userId, body);
  ok(res, success);
}

export async function phoneRequest(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.phoneRequestBody>>(req);
  await auth.requestPhoneCode(body.phone);
  ok(res, success);
}

export async function phoneVerify(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.phoneVerifyBody>>(req);
  ok(res, await auth.phoneLogin(body, ctxOf(req, body.deviceId)));
}

export async function linkPhone(req: Request, res: Response) {
  const { body } = valid<Body<typeof s.linkPhoneBody>>(req);
  ok(res, await methods.linkPhone(authUser(req).userId, body));
}

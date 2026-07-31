import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { APP_OPTIONS, type ApiOptions } from './config.js';
import { CsrfGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, SessionPrincipal } from './models.js';
import { Inject } from '@nestjs/common';
import { RegistrationService } from './registration.service.js';
import { requireObject } from './utils.js';

@Controller('api/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_OPTIONS) private readonly options: ApiOptions,
    @Inject(RegistrationService) private readonly registration: RegistrationService,
  ) {}

  @Post('login')
  async login(@Body() rawBody: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const body = requireObject(rawBody);
    const usernameKey = typeof body.username === 'string'
      ? body.username.trim().toLowerCase().slice(0, 64)
      : 'invalid';
    const loginKey = `${request.ip}:${usernameKey}`;
    this.auth.consumeLoginAttempt(loginKey);
    let result: Awaited<ReturnType<AuthService['login']>>;
    try {
      result = await this.auth.login(body.username, body.password);
      this.auth.clearLoginFailures(loginKey);
    } catch (error) {
      if (error instanceof UnauthorizedException && typeof body.username === 'string') {
        const hint = await this.registration.loginHintFor(body.username, body.password);
        if (hint?.status === 'pending') throw new UnauthorizedException('你的申请正在审核中,请耐心等待');
        if (hint?.status === 'rejected') throw new UnauthorizedException(`申请未通过:${hint.note || '请联系客服'}`);
      }
      throw error;
    }
    response.cookie('ca_session', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.options.secureCookies,
      maxAge: this.options.sessionTtlMs,
      path: '/',
    });
    response.cookie('ca_csrf', result.csrfToken, {
      httpOnly: false,
      sameSite: 'lax',
      secure: this.options.secureCookies,
      maxAge: this.options.sessionTtlMs,
      path: '/',
    });
    return {
      user: this.publicPrincipal(result.principal),
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt,
    };
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  me(@Req() rawRequest: Request) {
    const request = rawRequest as unknown as AuthenticatedRequest;
    return { user: this.publicPrincipal(request.principal as SessionPrincipal) };
  }

  @Post('logout')
  @UseGuards(SessionAuthGuard, CsrfGuard)
  logout(@Req() rawRequest: Request, @Res({ passthrough: true }) response: Response) {
    const request = rawRequest as unknown as AuthenticatedRequest;
    this.auth.logout((request.principal as SessionPrincipal).tokenHash);
    response.clearCookie('ca_session', { path: '/' });
    response.clearCookie('ca_csrf', { path: '/' });
    return { ok: true };
  }

  @Post('change-password')
  @UseGuards(SessionAuthGuard, CsrfGuard)
  async changePassword(@Req() rawRequest: Request, @Body() rawBody: unknown) {
    const request = rawRequest as unknown as AuthenticatedRequest;
    const body = requireObject(rawBody);
    await this.auth.changePassword(
      request.principal as SessionPrincipal,
      body.currentPassword,
      body.newPassword,
    );
    return { ok: true };
  }

  private publicPrincipal(principal: SessionPrincipal) {
    const workspaceRole = this.auth.primaryWorkspaceRole(principal.userId);
    return {
      id: principal.userId,
      username: principal.username,
      systemRole: principal.systemRole,
      userKind: principal.userKind,
      workspaceRole,
      role: principal.systemRole === 'admin' ? '系统管理员' : workspaceRole ?? '成员',
      mustChangePassword: principal.mustChangePassword,
    };
  }
}

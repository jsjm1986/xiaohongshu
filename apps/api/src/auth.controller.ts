import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { APP_OPTIONS, type ApiOptions } from './config.js';
import { CsrfGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, SessionPrincipal } from './models.js';
import { Inject } from '@nestjs/common';
import { requireObject } from './utils.js';

@Controller('api/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_OPTIONS) private readonly options: ApiOptions,
  ) {}

  @Post('login')
  async login(@Body() rawBody: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const body = requireObject(rawBody);
    const loginKey = `${request.ip}:${String(body.username ?? '').toLowerCase()}`;
    this.auth.assertLoginAllowed(loginKey);
    let result: Awaited<ReturnType<AuthService['login']>>;
    try {
      result = await this.auth.login(body.username, body.password);
      this.auth.clearLoginFailures(loginKey);
    } catch (error) {
      this.auth.recordLoginFailure(loginKey);
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
      workspaceRole,
      role: principal.systemRole === 'admin' ? '系统管理员' : workspaceRole ?? '成员',
      mustChangePassword: principal.mustChangePassword,
    };
  }
}

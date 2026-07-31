import { Body, Controller, Inject, Ip, Post } from '@nestjs/common';
import { RegistrationService } from './registration.service.js';
import { requireObject } from './utils.js';

@Controller('api/register')
export class RegistrationController {
  constructor(@Inject(RegistrationService) private readonly registration: RegistrationService) {}

  @Post()
  async submit(@Ip() ip: string, @Body() rawBody: unknown) {
    const key = ip || 'unknown';
    this.registration.consumeSubmitAttempt(key);
    const body = requireObject(rawBody);
    return this.registration.submit({
      username: body.username,
      password: body.password,
      organizationName: body.organizationName,
      phone: body.phone,
    });
  }
}

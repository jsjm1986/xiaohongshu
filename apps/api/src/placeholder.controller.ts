import { Controller, Get } from '@nestjs/common';

@Controller('api')
export class AppController {
  @Get()
  apiInfo() {
    return {
      name: 'Content Agent API',
      version: '0.1.0',
      health: '/health',
    };
  }
}

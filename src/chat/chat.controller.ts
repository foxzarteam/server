import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { assertMobileAccess, extractIdToken } from '../common/phone-access';
import { OtpService } from '../otp/otp.service';
import {
  CreateChatDto,
  parseAnswers,
  UpdateChatDto,
} from './chat.dto';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly otpService: OtpService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateChatDto) {
    const answers = parseAnswers(dto.answers);
    if (!answers) {
      throw new BadRequestException('Chat answers are incomplete.');
    }
    const row = await this.chatService.create(dto);
    if (!row) {
      throw new BadRequestException('Could not save chat.');
    }
    return { success: true, id: row.id, status: row.status };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateChatDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    if (!id?.trim()) {
      throw new BadRequestException('Missing chat id.');
    }
    const mobile = await this.chatService.getMobileById(id);
    if (!mobile) {
      throw new NotFoundException('Chat not found or nothing to update.');
    }
    await assertMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: extractIdToken(headers, dto.idToken),
    });

    const row = await this.chatService.updateById(id, dto);
    if (!row) {
      throw new NotFoundException('Chat not found or nothing to update.');
    }
    return { success: true, id: row.id, status: row.status };
  }
}

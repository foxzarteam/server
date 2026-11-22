import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Header,
  Param,
  Patch,
  Post,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminCrmGuard, AdminOnlyGuard, AdminPanelGuard } from '../common/admin-crm.guard';
import {
  AdminCreatePartnerDto,
  AdminUpdatePartnerDto,
} from './partner.dto';
import { PartnerService } from './partner.service';

@Controller('partners')
export class PartnerController {
  constructor(private readonly partnerService: PartnerService) {}

  @Get('admin/all')
  @UseGuards(AdminPanelGuard)
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin() {
    const data = await this.partnerService.getAll();
    return { success: true, data };
  }

  @Get('logo/:file')
  @Header('Cache-Control', 'public, max-age=86400, immutable')
  async getLogo(@Param('file') file: string) {
    const result = await this.partnerService.getLogo(file);
    if (!result.ok) throw new NotFoundException();
    return new StreamableFile(result.body, {
      type: result.contentType,
      disposition: 'inline',
    });
  }

  @Post('admin/image')
  @UseGuards(AdminCrmGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  @HttpCode(HttpStatus.OK)
  async uploadImage(
    @UploadedFile() file?: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ) {
    const result = await this.partnerService.uploadLogo(file);
    if (!result.ok) throw new BadRequestException(result.error);
    return { success: true, path: result.path };
  }

  @Post('admin')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.CREATED)
  async createForAdmin(@Body() dto: AdminCreatePartnerDto) {
    const row = await this.partnerService.create(dto);
    if (!row) {
      throw new NotFoundException('Failed to create partner');
    }
    return { success: true, data: row };
  }

  @Patch('admin/:id')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(@Param('id') id: string, @Body() dto: AdminUpdatePartnerDto) {
    const row = await this.partnerService.updateById(id, dto);
    if (!row) {
      throw new NotFoundException('Partner not found or update failed');
    }
    return { success: true, data: row };
  }

  @Delete('admin/:id')
  @UseGuards(AdminCrmGuard, AdminOnlyGuard)
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(@Param('id') id: string) {
    const ok = await this.partnerService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Partner not found or delete failed');
    }
    return { success: true };
  }
}

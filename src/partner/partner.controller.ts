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
  UseGuards,
} from '@nestjs/common';
import { AdminCrmGuard, AdminOnlyGuard, AdminPanelGuard } from '../common/admin-crm.guard';
import {
  AdminCreatePartnerDto,
  AdminUpdatePartnerDto,
  AdminUploadPartnerImageDto,
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
  @HttpCode(HttpStatus.OK)
  async uploadImage(@Body() dto: AdminUploadPartnerImageDto) {
    const result = await this.partnerService.uploadLogo({
      buffer: Buffer.from(String(dto.contentBase64 ?? ''), 'base64'),
      mimetype: dto.mimeType,
      originalname: dto.filename,
    });
    if (!result.ok) {
      return { success: false, path: '', message: result.error, error: result.error };
    }
    return { success: true, path: result.path };
  }

  @Post('admin')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.CREATED)
  async createForAdmin(@Body() dto: AdminCreatePartnerDto) {
    const result = await this.partnerService.create(dto);
    if (!result.ok) throw new BadRequestException(result.error);
    return { success: true, data: result.data };
  }

  @Patch('admin/:id')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(@Param('id') id: string, @Body() dto: AdminUpdatePartnerDto) {
    const result = await this.partnerService.updateById(id, dto);
    if (!result.ok) throw new BadRequestException(result.error);
    return { success: true, data: result.data };
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

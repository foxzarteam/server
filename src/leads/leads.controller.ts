import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { LeadsService } from './leads.service';
import { CreateLeadDto } from './dto/create-lead.dto';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async getAll() {
    return {
      success: true,
      message: 'Leads API is working! Use POST /api/leads to create a lead.',
      endpoints: {
        create: 'POST /api/leads',
        getByUser: 'GET /api/leads/user/:userId',
        getByCategory: 'GET /api/leads/user/:userId/category/:category',
      },
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateLeadDto) {
    try {
      if (process.env.NODE_ENV !== 'production') {
        console.log('LeadsController.create - Received DTO:', JSON.stringify(dto, null, 2));
        console.log('LeadsController.create - PAN:', dto.pan);
        console.log('LeadsController.create - Mobile:', dto.mobileNumber);
        console.log('LeadsController.create - Category:', dto.category);
      }
      // Reject duplicate active lead for same mobile number
      const duplicateCheck = await this.leadsService
        .getByUserId(dto.userId ?? '')
        .catch(() => [] as Record<string, unknown>[]);

      if (
        duplicateCheck.some(
          (l) => (l['mobile_number'] as string | undefined)?.trim() === dto.mobileNumber.trim(),
        )
      ) {
        return {
          success: false,
          message: 'This lead already exists in our system.',
        };
      }

      const lead = await this.leadsService.create(dto);
      if (!lead) {
        if (process.env.NODE_ENV !== 'production') {
          console.error('LeadsController.create - Service returned null');
        }
        return { success: false, message: 'Failed to create lead' };
      }
      return { success: true, data: lead };
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsController.create - Error:', error);
      }
      return { 
        success: false, 
        message: error instanceof Error ? error.message : 'Failed to create lead' 
      };
    }
  }

  @Get('user/:userId')
  @HttpCode(HttpStatus.OK)
  async getByUserId(@Param('userId') userId: string) {
    const leads = await this.leadsService.getByUserId(userId);
    return { success: true, data: leads };
  }

  @Get('user/:userId/category/:category')
  @HttpCode(HttpStatus.OK)
  async getByCategory(
    @Param('userId') userId: string,
    @Param('category') category: string,
  ) {
    const leads = await this.leadsService.getByCategory(userId, category);
    return { success: true, data: leads };
  }
}

import { IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(['owner', 'editor', 'viewer'])
  role?: 'owner' | 'editor' | 'viewer';
}

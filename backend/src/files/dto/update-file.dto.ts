import { IsOptional, IsString, MaxLength, Matches } from 'class-validator';

export class UpdateFileDto {
  @IsOptional()
  @IsString()
  @Matches(/^[^\n\r]*$/, { message: 'name must be a single line' })
  @MaxLength(180)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[^\n\r]*$/, { message: 'path must be a single line' })
  @MaxLength(500)
  path?: string;
}

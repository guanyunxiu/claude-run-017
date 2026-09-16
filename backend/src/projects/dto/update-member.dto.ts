import { IsIn } from 'class-validator';

export class UpdateMemberDto {
  @IsIn(['editor', 'viewer'])
  role!: 'editor' | 'viewer';
}

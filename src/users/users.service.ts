import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { LoginHistory } from './entities/login-history.entity';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(LoginHistory)
    private readonly loginHistoryRepository: Repository<LoginHistory>,
  ) {}

  async create(createUserDto: Partial<User> & CreateUserDto): Promise<User> {
    const existing = await this.findByEmail(createUserDto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }
    const user = this.usersRepository.create(createUserDto);
    return this.usersRepository.save(user);
  }

  findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findById(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }
  

  async findByIdWithAuthorization(id: string): Promise<User> {
  const user = await this.usersRepository.findOne({
    where: { id },
    relations: {
      userRoles: {
        role: {
          rolePermissions: {
            permission: true,
          },
        },
      },
    },
  });

  if (!user) {
    throw new NotFoundException('User not found');
  }

  return user;
}

  findByEmailVerificationToken(token: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { emailVerificationToken: token } });
  }

  findByPasswordResetToken(token: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { passwordResetToken: token } });
  }

  async save(user: User): Promise<User> {
    return this.usersRepository.save(user);
  }

  async recordLoginHistory(entry: Partial<LoginHistory>): Promise<void> {
    const record = this.loginHistoryRepository.create(entry);
    await this.loginHistoryRepository.save(record);
  }

  async getLoginHistory(userId: string, limit = 20): Promise<LoginHistory[]> {
    return this.loginHistoryRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly fromAddress: string;
  private readonly frontendUrl: string;

  constructor(private readonly configService: ConfigService) {
    const port = this.configService.get<number>('MAIL_PORT');
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('MAIL_HOST'),
      port,
      // Port 465 = implicit TLS. Any other port (587 for Gmail) uses STARTTLS:
      // the connection starts unencrypted and upgrades to TLS via requireTLS.
      secure: port === 465,
      requireTLS: port !== 465,
      auth: {
        // Credentials always come from environment variables — never hardcode
        // them here. For Gmail, MAIL_PASSWORD must be a 16-character App
        // Password (Google Account -> Security -> 2-Step Verification ->
        // App passwords), not the normal account password.
        user: this.configService.get<string>('MAIL_USER'),
        pass: this.configService.get<string>('MAIL_PASSWORD'),
      },
    });
    this.fromAddress = this.configService.get<string>('MAIL_FROM') ?? 'no-reply@example.com';
    this.frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.transporter.sendMail({ from: this.fromAddress, to, subject, html });
    } catch (error) {
      // Don't leak SMTP errors to the caller/user; log for ops instead.
      this.logger.error(`Failed to send email to ${to}: ${(error as Error).message}`);
    }
  }

  async sendEmailVerification(to: string, token: string): Promise<void> {
    const link = `${this.frontendUrl}/verify-email?token=${token}`;
    await this.send(
      to,
      'Verify your email address',
      `<p>Welcome! Please verify your email address by clicking the link below:</p>
       <p><a href="${link}">${link}</a></p>
       <p>This link expires in 24 hours.</p>`,
    );
  }

  async sendPasswordReset(to: string, token: string): Promise<void> {
    const link = `${this.frontendUrl}/reset-password?token=${token}`;
    await this.send(
      to,
      'Reset your password',
      `<p>We received a request to reset your password. Click the link below to choose a new one:</p>
       <p><a href="${link}">${link}</a></p>
       <p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>`,
    );
  }

  async sendAccountLockedNotice(to: string): Promise<void> {
    await this.send(
      to,
      'Your account has been temporarily locked',
      `<p>We detected multiple failed login attempts on your account. It has been temporarily
       locked for your security. If this wasn't you, consider resetting your password.</p>`,
    );
  }
}

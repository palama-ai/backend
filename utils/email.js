const nodemailer = require('nodemailer');

// Create reusable transporter
let transporter = null;

function getTransporter() {
    if (transporter) return transporter;

    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = parseInt(process.env.SMTP_PORT || '587');
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!user || !pass) {
        console.warn('[email] SMTP credentials not configured. Emails will not be sent.');
        return null;
    }

    transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
    });

    return transporter;
}

/**
 * Send password reset code email
 */
async function sendPasswordResetCode(email, code) {
    const transport = getTransporter();
    if (!transport) {
        console.log(`[email] Would send reset code ${code} to ${email} (SMTP not configured)`);
        return { success: false, reason: 'SMTP not configured' };
    }

    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    try {
        await transport.sendMail({
            from,
            to: email,
            subject: 'Glowimatch - Password Reset Code',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #ec4899; margin: 0;">Glowimatch</h1>
                        <p style="color: #666; margin-top: 5px;">Password Reset Request</p>
                    </div>
                    
                    <p>Hello,</p>
                    <p>You requested to reset your password. Use the code below to complete the process:</p>
                    
                    <div style="background: linear-gradient(135deg, #ec4899 0%, #f43f5e 100%); color: white; padding: 20px; border-radius: 12px; text-align: center; margin: 25px 0;">
                        <p style="margin: 0; font-size: 14px; opacity: 0.9;">Your Reset Code</p>
                        <p style="margin: 10px 0 0 0; font-size: 32px; font-weight: bold; letter-spacing: 8px;">${code}</p>
                    </div>
                    
                    <p style="color: #666; font-size: 14px;">This code will expire in <strong>15 minutes</strong>.</p>
                    <p style="color: #666; font-size: 14px;">If you didn't request this, please ignore this email.</p>
                    
                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                    <p style="color: #999; font-size: 12px; text-align: center;">
                        © ${new Date().getFullYear()} Glowimatch. All rights reserved.
                    </p>
                </div>
            `
        });

        console.log(`[email] Reset code sent to ${email}`);
        return { success: true };
    } catch (err) {
        console.error('[email] Failed to send reset code:', err.message);
        return { success: false, reason: err.message };
    }
}

/**
 * Send welcome email (optional)
 */
async function sendWelcomeEmail(email, name) {
    const transport = getTransporter();
    if (!transport) return { success: false, reason: 'SMTP not configured' };

    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    try {
        await transport.sendMail({
            from,
            to: email,
            subject: 'Welcome to Glowimatch! ✨',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #ec4899; margin: 0;">Welcome to Glowimatch! ✨</h1>
                    </div>
                    
                    <p>Hello ${name || 'there'},</p>
                    <p>Thank you for joining Glowimatch! We're excited to help you discover your perfect skincare routine.</p>
                    
                    <div style="background: #fdf2f8; padding: 20px; border-radius: 12px; margin: 25px 0;">
                        <p style="margin: 0; color: #be185d;"><strong>What's next?</strong></p>
                        <ul style="color: #666; margin: 10px 0 0 0; padding-left: 20px;">
                            <li>Take our skin analysis quiz</li>
                            <li>Get personalized product recommendations</li>
                            <li>Build your perfect skincare routine</li>
                        </ul>
                    </div>
                    
                    <p>Happy glowing! 💗</p>
                    <p style="color: #666;">The Glowimatch Team</p>
                </div>
            `
        });

        console.log(`[email] Welcome email sent to ${email}`);
        return { success: true };
    } catch (err) {
        console.error('[email] Failed to send welcome email:', err.message);
        return { success: false, reason: err.message };
    }
}

/**
 * Send email verification code
 */
async function sendVerificationCode(email, code, name) {
    const transport = getTransporter();
    if (!transport) {
        console.log(`[email] Would send verification code ${code} to ${email} (SMTP not configured)`);
        return { success: false, reason: 'SMTP not configured' };
    }

    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    try {
        await transport.sendMail({
            from,
            to: email,
            subject: 'Glowimatch - Verify Your Email',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #ec4899; margin: 0;">Glowimatch</h1>
                        <p style="color: #666; margin-top: 5px;">Email Verification</p>
                    </div>
                    
                    <p>Hello${name ? ` ${name}` : ''},</p>
                    <p>Welcome to Glowimatch! Please verify your email address using the code below:</p>
                    
                    <div style="background: linear-gradient(135deg, #ec4899 0%, #f43f5e 100%); color: white; padding: 20px; border-radius: 12px; text-align: center; margin: 25px 0;">
                        <p style="margin: 0; font-size: 14px; opacity: 0.9;">Your Verification Code</p>
                        <p style="margin: 10px 0 0 0; font-size: 32px; font-weight: bold; letter-spacing: 8px;">${code}</p>
                    </div>
                    
                    <p style="color: #666; font-size: 14px;">This code will expire in <strong>15 minutes</strong>.</p>
                    <p style="color: #666; font-size: 14px;">If you didn't create an account, please ignore this email.</p>
                    
                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                    <p style="color: #999; font-size: 12px; text-align: center;">
                        © ${new Date().getFullYear()} Glowimatch. All rights reserved.
                    </p>
                </div>
            `
        });

        console.log(`[email] Verification code sent to ${email}`);
        return { success: true };
    } catch (err) {
        console.error('[email] Failed to send verification code:', err.message);
        return { success: false, reason: err.message };
    }
}

module.exports = {
    sendPasswordResetCode,
    sendWelcomeEmail,
    sendVerificationCode
};

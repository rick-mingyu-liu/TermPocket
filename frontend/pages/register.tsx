import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { BrandLogo } from '@/components/BrandLogo'
import { useForm } from 'react-hook-form'
import { Eye, EyeOff, Mail, Lock, User, ArrowLeft, CheckCircle, AlertTriangle } from 'lucide-react'
import { api } from '@/utils/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import Swal from 'sweetalert2'
import Link from 'next/link'
import { Trans, useTranslation } from 'next-i18next'
import { serverSideTranslations } from 'next-i18next/serverSideTranslations'

interface RegisterForm {
  first_name: string
  last_name: string
  email: string
  password: string
  confirmPassword: string
}

// Enhanced email validation function
const validateEmail = (email: string) => {
  // Basic format check
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(email)) {
    return 'Please enter a valid email address';
  }

  // Check length limits
  if (email.length > 254) {
    return 'Email address is too long';
  }

  const [localPart, domain] = email.split('@');
  if (localPart.length > 64) {
    return 'Email local part is too long';
  }

  // Check for invalid patterns
  if (email.includes('..') || email.startsWith('.') || email.endsWith('.')) {
    return 'Invalid email format';
  }

  if (email.includes('@.') || email.includes('.@')) {
    return 'Invalid email format';
  }

  // Check for common disposable email domains
  const disposableDomains = [
    '10minutemail.com', 'guerrillamail.com', 'mailinator.com', 'tempmail.org',
    'throwaway.email', 'temp-mail.org', 'yopmail.com', 'trashmail.com',
    'maildrop.cc', 'mailinator.net', 'fakeinbox.com', 'spam4.me'
  ];

  if (disposableDomains.includes(domain.toLowerCase())) {
    return 'Disposable email addresses are not allowed';
  }

  // Check for test patterns
  if (localPart.includes('test') && domain.includes('test')) {
    return 'Test email addresses are not allowed';
  }

  // Check for sequential characters
  if (/(.)\1{4,}/.test(localPart)) {
    return 'Invalid email format';
  }

  return true;
};

export default function Register() {
  const router = useRouter()
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [registrationSuccess, setRegistrationSuccess] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [registerError, setRegisterError] = useState('')
  // The terms tick box: unticked by default, and Create account stays disabled until it is ticked.
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [language, setLanguage] = useState('en');
  // The server renders the form before React attaches its submit handler. A
  // click in that window would submit natively (a GET to this page, fields in
  // the URL) or do nothing visible, so the button stays disabled until mounted.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => { setHydrated(true) }, [])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const sysLang = navigator.language || navigator.languages?.[0] || 'en';
      if (sysLang.startsWith('zh')) {
        setLanguage('zh');
      } else {
        setLanguage('en');
      }
    }
  }, []);
  
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<RegisterForm>()

  const password = watch('password')

  const onSubmit = async (data: RegisterForm) => {
    try {
      setLoading(true)
      setRegisterError('')
      const { confirmPassword, ...registerData } = data
      const response = await api.post('/auth/register', {
        ...registerData,
        language,
        accept_terms: acceptedTerms,
      })
      if (response.data.requiresVerification) {
        setRegistrationSuccess(true)
        setUserEmail(data.email)
        Swal.fire({
          icon: 'success',
          title: t('Registration successful!'),
          text: t("Check your inbox for a verification email. If you don't see it, check Spam or Junk and mark it as \"Not spam.\""),
        })
      } else {
        localStorage.setItem('token', response.data.token)
        localStorage.setItem('user', JSON.stringify(response.data.user))
        Swal.fire({
          icon: 'success',
          title: 'Registration successful!',
          text: 'Welcome to TermPocket.',
        })
        router.push('/')
      }
    } catch (error: any) {
      // Custom error handling for already registered users
      if (error.response?.data?.error === 'User already exists') {
        setRegisterError(t("This email is already registered. If you have not verified it, check your inbox or Spam/Junk for the verification email. If you find it in Spam/Junk, mark it as \"Not spam.\" If you already verified, please log in."))
      } else if (error.response?.data?.error) {
        setRegisterError(error.response.data.error)
      } else {
        setRegisterError('Registration failed. Please try again.')
      }
      console.error('Registration error:', error)
    } finally {
      setLoading(false)
    }
  }

  // Prevent blank spaces in input fields
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    if (value.includes(' ')) {
      e.target.value = value.replace(/\s/g, '')
    }
  }

  const { t } = useTranslation()

  if (registrationSuccess) {
    return (
      <>
        <Head>
          <title>Check Your Email - TermPocket</title>
          <meta name="description" content="Verify your TermPocket account" />
        </Head>

        <div className="min-h-screen bg-background flex flex-col justify-center py-12 sm:px-6 lg:px-8 aurora-particles">
          <div className="sm:mx-auto sm:w-full sm:max-w-md">
            <div className="text-center">
              <h1 className="mx-auto mb-4 flex justify-center">
                <BrandLogo className="h-14 sm:h-16" priority />
              </h1>
            </div>
          </div>

          <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
            <Card className="shadow-xl dark:shadow-xl bg-card border border-border text-card-foreground">
              <CardHeader className="space-y-1 text-center">
                <div className="flex justify-center mb-4">
                  <CheckCircle className="h-16 w-16 text-green-500" />
                </div>
                <CardTitle className="text-2xl text-green-700 dark:text-green-400">
                  {t('Check Your Email')}
                </CardTitle>
                <CardDescription className="text-center">
                  {t('We\'ve sent a verification link to your email address')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <p className="text-sm text-blue-800 dark:text-blue-200">
                    <strong>{t('Email:')}</strong> {userEmail}
                  </p>
                </div>
                
                <div className="space-y-3 text-sm text-gray-600 dark:text-gray-400">
                  <p>{t('• Click the verification link in your email to activate your account')}</p>
                  <p>{t('• The link will expire in 30 minutes')}</p>
                </div>

                <div className="flex items-start gap-2 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                  <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-yellow-800 dark:text-yellow-200">{t("Check your inbox for a verification email. If you don't see it, check Spam or Junk and mark it as \"Not spam.\"")}</p>
                </div>

                <div className="space-y-2">
                  <Button 
                    onClick={() => router.push('/login')}
                    className="w-full bg-green-600 hover:bg-green-700 text-white"
                  >
                    {t('Continue to Login')}
                  </Button>
                  <Button 
                    onClick={() => setRegistrationSuccess(false)}
                    variant="outline"
                    className="w-full border-yellow-400 dark:border-yellow-500 text-yellow-700 dark:text-yellow-300"
                  >
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    {t('Back to Registration')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Head>
        <title>Register - TermPocket</title>
        <meta name="description" content="Create your TermPocket account" />
      </Head>

      <div className="min-h-screen bg-background flex flex-col justify-center py-12 sm:px-6 lg:px-8 aurora-particles">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <div className="text-center">
            <h1 className="mx-auto mb-4 flex justify-center">
              <BrandLogo className="h-14 sm:h-16" priority />
            </h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('Create your account')}</p>
          </div>
        </div>

        <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
          <Card className="shadow-xl dark:shadow-xl bg-card border border-border text-card-foreground">
            <CardHeader className="space-y-1">
              <CardTitle className="text-2xl text-center text-green-700 dark:text-green-400">{t('Create account')}</CardTitle>
              <CardDescription className="text-center">{t('Enter your information to create your account')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleSubmit(onSubmit)}>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="first_name">{t('First name')}</Label>
                    <div className="relative">
                      <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="first_name"
                        placeholder={t('First name')}
                        className="pl-10 bg-gray-50 dark:bg-background border-gray-300 dark:border-input text-foreground"
                        onInput={handleInputChange}
                        onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                        {...register('first_name', {
                          required: 'First name is required',
                          minLength: {
                            value: 2,
                            message: 'First name must be at least 2 characters',
                          },
                          validate: (value) => !/\s/.test(value) || 'First name cannot contain spaces',
                        })}
                      />
                    </div>
                    {errors.first_name && (
                      <p className="text-sm text-red-600 dark:text-red-400 font-medium">{errors.first_name.message}</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="last_name">{t('Last name')}</Label>
                    <div className="relative">
                      <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="last_name"
                        placeholder={t('Last name')}
                        className="pl-10 bg-gray-50 dark:bg-background border-gray-300 dark:border-input text-foreground"
                        onInput={handleInputChange}
                        onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                        {...register('last_name', {
                          required: 'Last name is required',
                          minLength: {
                            value: 2,
                            message: 'Last name must be at least 2 characters',
                          },
                          validate: (value) => !/\s/.test(value) || 'Last name cannot contain spaces',
                        })}
                      />
                    </div>
                    {errors.last_name && (
                      <p className="text-sm text-red-600 dark:text-red-400 font-medium">{errors.last_name.message}</p>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">{t('Email address')}</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      placeholder={t('Enter your email')}
                      className="pl-10 bg-gray-50 dark:bg-background border-gray-300 dark:border-input text-foreground"
                      onInput={handleInputChange}
                      onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                      {...register('email', {
                        required: 'Email is required',
                        validate: (value) => {
                          if (/\s/.test(value)) return 'Email cannot contain spaces';
                          const emailValidation = validateEmail(value);
                          if (emailValidation !== true) return emailValidation;
                          return true;
                        },
                      })}
                    />
                  </div>
                  {errors.email && (
                    <p className="text-sm text-red-600 dark:text-red-400 font-medium">{errors.email.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">{t('Password')}</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder={t('Create a password')}
                      className="pl-10 pr-10 bg-gray-50 dark:bg-background border-gray-300 dark:border-input text-foreground"
                      onInput={handleInputChange}
                      onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                      {...register('password', {
                        required: 'Password is required',
                        minLength: {
                          value: 6,
                          message: 'Password must be at least 6 characters',
                        },
                        validate: (value) => !/\s/.test(value) || 'Password cannot contain spaces',
                      })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  {errors.password && (
                    <p className="text-sm text-red-600 dark:text-red-400 font-medium">{errors.password.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">{t('Confirm password')}</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="confirmPassword"
                      type={showConfirmPassword ? 'text' : 'password'}
                      placeholder={t('Confirm your password')}
                      className="pl-10 pr-10 bg-gray-50 dark:bg-background border-gray-300 dark:border-input text-foreground"
                      onInput={handleInputChange}
                      onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                      {...register('confirmPassword', {
                        required: 'Please confirm your password',
                        validate: (value) =>
                          (!/\s/.test(value) ? (value === password || 'Passwords do not match') : 'Password cannot contain spaces'),
                      })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  {errors.confirmPassword && (
                    <p className="text-sm text-red-600 dark:text-red-400 font-medium">{errors.confirmPassword.message}</p>
                  )}
                </div>

                {registerError && (
                  <div className="mb-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg flex items-start space-x-2">
                    <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">{registerError}</p>
                    </div>
                  </div>
                )}

                <div className="flex items-start gap-2">
                  <input
                    id="acceptTerms"
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={(e) => setAcceptedTerms(e.target.checked)}
                    className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-gray-300 accent-green-600"
                  />
                  <label htmlFor="acceptTerms" className="text-sm leading-snug text-muted-foreground">
                    {/* New tab, so following a link does not lose what was typed. */}
                    <Trans
                      i18nKey="legalConsent"
                      t={t}
                      components={{
                        terms: <Link href="/terms" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground" />,
                        privacy: <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground" />,
                      }}
                    />
                  </label>
                </div>

                <Button type="submit" className="w-full bg-green-600 hover:bg-green-700 text-white" disabled={loading || !hydrated || !acceptedTerms}>
                  {loading ? t('Creating account...') : t('Create account')}
                </Button>
              </form>

              <div className="mt-6">
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-yellow-400" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-background px-2 text-yellow-700 dark:text-yellow-300">
                      {t('Already have an account?')}
                    </span>
                  </div>
                </div>

                <Button
                  variant="outline"
                  className="w-full mt-4 border-yellow-400 dark:border-yellow-500 text-yellow-700 dark:text-yellow-300"
                  onClick={() => router.push('/login')}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {t('Sign in to existing account')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
} 

export async function getStaticProps({ locale }: { locale: string }) {
  return {
    props: {
      ...(await serverSideTranslations(locale, ['common'])),
    },
  }
} 
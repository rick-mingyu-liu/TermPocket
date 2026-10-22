import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import Image from 'next/image'
import Link from 'next/link'
import { BrandLogo } from '@/components/BrandLogo'
import { useForm } from 'react-hook-form'
import { Eye, EyeOff, Mail, Lock, ArrowRight, Shield, Target, CalendarRange, ScanText, Coins, AlertCircle, AlertTriangle } from 'lucide-react'
import { api } from '@/utils/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import Swal from 'sweetalert2'
import { useTranslation } from 'next-i18next'
import { serverSideTranslations } from 'next-i18next/serverSideTranslations'

interface LoginForm {
  email: string
  password: string
}

export default function Login() {
  const router = useRouter()
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showIntro, setShowIntro] = useState(false)
  const [verificationError, setVerificationError] = useState('')
  const [resendLoading, setResendLoading] = useState(false)
  const [loginError, setLoginError] = useState('')
  // The server renders the form before React attaches its submit handler. A
  // click in that window would submit natively (a GET to this page, fields in
  // the URL) or do nothing visible, so the button stays disabled until mounted.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => { setHydrated(true) }, [])
  
  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
  } = useForm<LoginForm>()

  const email = watch('email')
  const { t } = useTranslation()

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('token');
      if (!token) {
        const sysLang = navigator.language || navigator.languages?.[0] || 'en';
        if (sysLang.startsWith('zh')) {
          // Set app language to Mandarin
          localStorage.setItem('userLanguage', 'zh');
        } else {
          localStorage.setItem('userLanguage', 'en');
        }
      }
    }
  }, []);

  const onSubmit = async (data: LoginForm) => {
    try {
      setLoading(true)
      setVerificationError('')
      setLoginError('')
      
      const response = await api.post('/auth/login', data)
      
      // Store token and user data
      localStorage.setItem('token', response.data.token)
      localStorage.setItem('user', JSON.stringify(response.data.user))
      
      Swal.fire({
        icon: 'success',
        title: t('Login successful!'),
        text: t('Welcome back!'),
        confirmButtonColor: '#facc15',
      })
      router.push('/')
      
    } catch (error: any) {
      console.error('Login error:', error)
      
      if (error.response?.data?.requiresVerification) {
        setVerificationError(error.response.data.error)
      } else if (error.response?.data?.error) {
        setLoginError(error.response.data.error)
      } else {
        setLoginError('An unexpected error occurred. Please try again.')
      }
      // Other error handling is done in api interceptor
    } finally {
      setLoading(false)
    }
  }

  const handleResendVerification = async () => {
    if (!email) {
      Swal.fire({
        icon: 'error',
        title: 'Error',
        text: 'Please enter your email address first',
      })
      return
    }

    try {
      setResendLoading(true)
      await api.post('/auth/resend-verification', { email })
      Swal.fire({
        icon: 'success',
        title: 'Verification email sent successfully!',
        text: t("Check your inbox for a verification email. If you don't see it, check Spam or Junk and mark it as \"Not spam.\""),
      })
      setVerificationError('')
    } catch (error: any) {
      Swal.fire({
        icon: 'error',
        title: 'Error',
        text: error.response?.data?.error || 'Failed to send verification email',
      })
    } finally {
      setResendLoading(false)
    }
  }

  // Prevent blank spaces in input fields
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    if (value.includes(' ')) {
      e.target.value = value.replace(/\s/g, '')
    }
  }

  return (
    <>
      <Head>
        <title>Login - TermPocket</title>
        <meta name="description" content="Sign in to your TermPocket account" />
      </Head>

      <div className="min-h-screen relative flex flex-col justify-center py-12 sm:px-6 lg:px-8 bg-white dark:bg-gray-950 aurora-particles">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <div className="text-center">
            <h1 className="mx-auto mb-4 flex justify-center">
              <BrandLogo className="h-14 sm:h-16" priority />
            </h1>
            <button
              onClick={() => setShowIntro(true)}
              className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline cursor-pointer transition-colors"
            >
              {t('Who are we?')}
            </button>
          </div>
        </div>

        <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
          <Card className="shadow-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-900 dark:text-gray-100">
            <CardHeader className="space-y-1">
              <CardTitle className="text-2xl text-center text-green-700 dark:text-green-400">{t('Welcome back')}</CardTitle>
              <CardDescription className="text-center">
                {t('Enter your credentials to access your account')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loginError && (
                <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <div className="flex items-start space-x-2">
                    <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-red-800 dark:text-red-200">
                        {t(loginError)}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {verificationError && (
                <div className="mb-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                  <div className="flex items-start space-x-2">
                    <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2">
                        {verificationError}
                      </p>
                      <Button
                        onClick={handleResendVerification}
                        disabled={resendLoading}
                        size="sm"
                        className="bg-yellow-600 hover:bg-yellow-700 text-white"
                      >
                        {resendLoading ? 'Sending...' : 'Resend Verification Email'}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <form className="space-y-4" onSubmit={handleSubmit(onSubmit)}>
                <div className="space-y-2">
                  <Label htmlFor="email">{t('Email address')}</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      placeholder={t('Enter your email')}
                      className="pl-10 bg-gray-50 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-900 dark:text-gray-100"
                      onInput={handleInputChange}
                      onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                      {...register('email', {
                        required: 'Email is required',
                        pattern: {
                          value: /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i,
                          message: 'Invalid email address',
                        },
                        validate: (value) => !/\s/.test(value) || 'Email cannot contain spaces',
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
                      placeholder={t('Enter your password')}
                      className="pl-10 pr-10 bg-gray-50 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-900 dark:text-gray-100"
                      onInput={handleInputChange}
                      onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                      {...register('password', {
                        required: t('Password is required'),
                        minLength: {
                          value: 6,
                          message: t('Password must be at least 6 characters'),
                        },
                        validate: (value) => !/\s/.test(value) || t('Password cannot contain spaces'),
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

                <Button type="submit" className="w-full bg-green-600 hover:bg-green-700 text-white" disabled={loading || !hydrated}>
                  {loading ? t('Signing in...') : t('Sign in')}
                </Button>
              </form>

              <div className="mt-6">
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-yellow-400" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-background px-2 text-muted-foreground">
                      {t("Don't have an account?")}
                    </span>
                  </div>
                </div>

                <Button
                  variant="outline"
                  className="w-full mt-4 border-yellow-400 dark:border-yellow-500 text-yellow-700 dark:text-yellow-300"
                  onClick={() => router.push('/register')}
                >
                  {t('Create new account')}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>

              {/* Demo credentials */}
              <div className="mt-6 p-4 bg-muted rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="secondary" className="bg-yellow-400 dark:bg-yellow-500 text-yellow-900 dark:text-yellow-950">{t('Demo Account')}</Badge>
                </div>
                <div className="space-y-1 text-sm">
                  <p className="text-muted-foreground">
                    <span className="font-medium">{t('Email')}:</span> john.doe@example.com
                  </p>
                  <p className="text-muted-foreground">
                    <span className="font-medium">{t('Password')}:</span> password123
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
          <div className="mt-6 flex justify-center gap-4 text-xs text-muted-foreground">
            <Link href="/terms" className="underline-offset-2 hover:text-foreground hover:underline">{t('Terms of Service')}</Link>
            <Link href="/privacy" className="underline-offset-2 hover:text-foreground hover:underline">{t('Privacy Policy')}</Link>
          </div>
        </div>
      </div>

      {/* Who are we Modal */}
      <Dialog open={showIntro} onOpenChange={setShowIntro}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto bg-white dark:bg-gray-900 border border-yellow-400 dark:border-yellow-500 shadow-2xl text-gray-900 dark:text-gray-100">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              <Image
                src="/brand/termpocket-icon.svg"
                alt=""
                aria-hidden="true"
                width={60}
                height={60}
                className="h-14 w-14 shrink-0 dark:hidden"
              />
              <Image
                src="/brand/termpocket-icon-dark.svg"
                alt=""
                aria-hidden="true"
                width={60}
                height={60}
                className="hidden h-14 w-14 shrink-0 dark:block"
              />
              <div>
                <h2 className="text-2xl font-bold text-green-700 dark:text-green-400">{t('Welcome to TermPocket')}</h2>
                <p className="text-sm text-muted-foreground">{t('Your money, term by term.')}</p>
              </div>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-6">
            <div className="text-center py-4">
              <h3 className="text-xl font-semibold mb-2 text-green-700 dark:text-green-400">{t('Built for student life')}</h3>
              <p className="text-muted-foreground">
                {t('A study term spends and a co-op term earns. TermPocket helps university and college students in Canada follow their money the way they live it: one four-month term at a time, through study terms, co-op placements, internships and summer breaks.')}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-green-100 dark:bg-green-900 rounded-lg shrink-0">
                  <CalendarRange className="h-5 w-5 text-green-600 dark:text-green-400" aria-hidden="true" />
                </div>
                <div>
                  <h4 className="font-semibold text-green-700 dark:text-green-400">{t('Term by term')}</h4>
                  <p className="text-sm text-muted-foreground">{t('See income, spending and savings for this term, last term or the whole year, so a co-op term and a study term are easy to compare.')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg shrink-0">
                  <ScanText className="h-5 w-5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                </div>
                <div>
                  <h4 className="font-semibold text-green-700 dark:text-green-400">{t('Import from a screenshot')}</h4>
                  <p className="text-sm text-muted-foreground">{t('Add transactions from a screenshot of your banking app, a receipt, Uber, Uber Eats or WeChat Pay. The image is read on your device and never uploaded, and nothing is saved until you confirm.')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 bg-emerald-100 dark:bg-emerald-900 rounded-lg shrink-0">
                  <Target className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                </div>
                <div>
                  <h4 className="font-semibold text-green-700 dark:text-green-400">{t('Savings goals')}</h4>
                  <p className="text-sm text-muted-foreground">{t('Set a target amount and a date, and watch your progress toward it.')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 bg-amber-100 dark:bg-amber-900 rounded-lg shrink-0">
                  <Coins className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                </div>
                <div>
                  <h4 className="font-semibold text-green-700 dark:text-green-400">{t('Six currencies')}</h4>
                  <p className="text-sm text-muted-foreground">{t('Record money in CAD, USD, EUR, GBP, AUD or CNY, and see your totals in the currency you choose.')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 bg-orange-100 dark:bg-orange-900 rounded-lg shrink-0">
                  <Mail className="h-5 w-5 text-orange-600 dark:text-orange-400" aria-hidden="true" />
                </div>
                <div>
                  <h4 className="font-semibold text-green-700 dark:text-green-400">{t('Weekly report')}</h4>
                  <p className="text-sm text-muted-foreground">{t('Get a summary of your week by email every Sunday evening. Turn it off any time in Settings.')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 bg-teal-100 dark:bg-teal-900 rounded-lg shrink-0">
                  <Shield className="h-5 w-5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
                </div>
                <div>
                  <h4 className="font-semibold text-green-700 dark:text-green-400">{t('Private by design')}</h4>
                  <p className="text-sm text-muted-foreground">{t('TermPocket never connects to your bank. Passwords are stored hashed, and screenshots stay on your device.')}</p>
                </div>
              </div>
            </div>

            <div className="text-center space-y-4">
              <p className="text-muted-foreground">
                {t('TermPocket is free, in English and Chinese. Try the demo account, or create your own.')}
              </p>
              <div className="flex gap-3 justify-center flex-wrap">
                <Button onClick={() => router.push('/register')}>
                  {t('Get Started Free')}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <Button variant="outline" onClick={() => setShowIntro(false)}>
                  {t('Continue to Login')}
                </Button>
              </div>
            </div>

            <div className="border-t border-border pt-6 text-center">
              <p className="text-sm text-muted-foreground mb-3">
                {t('Questions, feedback or ideas? We would love to hear from you.')}
              </p>
              <a
                href="mailto:support@termpocket.com"
                className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-green-600 dark:border-green-500 text-green-700 dark:text-green-300 bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2"
              >
                {t('Contact Us')}
                <Mail className="ml-2 h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          </div>
        </DialogContent>
      </Dialog>
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

/* Add this to your global CSS (e.g., globals.css or in a <style jsx global>)
.floating-tech-icons {
  animation: marquee 18s linear infinite;
}
@keyframes marquee {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}
*/ 
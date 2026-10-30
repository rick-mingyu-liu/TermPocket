import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { BrandLogo } from '@/components/BrandLogo'
import { CheckCircle, XCircle, Mail, ArrowRight } from 'lucide-react'
import { api } from '@/utils/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useTranslation } from 'next-i18next'
import { serverSideTranslations } from 'next-i18next/serverSideTranslations'

export default function VerifyEmail() {
  const router = useRouter()
  const [verificationStatus, setVerificationStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [hasAttemptedVerification, setHasAttemptedVerification] = useState(false)
  const { t } = useTranslation()

  useEffect(() => {
    const { token } = router.query
    
    if (token && typeof token === 'string' && !hasAttemptedVerification) {
      setHasAttemptedVerification(true)
      verifyEmail(token)
    }
  }, [router.query, hasAttemptedVerification])

  const verifyEmail = async (token: string) => {
    if (token.length !== 64) {
      setVerificationStatus('error')
      setMessage('Invalid or incomplete verification link. Please use the link sent to your email.')
      return
    }
    try {
      const response = await api.get(`/auth/verify-email/${token}`)
      if (response.data.alreadyVerified) {
        setVerificationStatus('success')
        setMessage(response.data.message)
        setUserEmail(response.data.user.email)
        return
      }
      setVerificationStatus('success')
      setMessage(response.data.message)
      setUserEmail(response.data.user.email)
    } catch (error: any) {
      setVerificationStatus('error')
      setMessage(error.response?.data?.error || 'Verification failed')
    }
  }

  const getStatusIcon = () => {
    switch (verificationStatus) {
      case 'success':
        return <CheckCircle className="h-16 w-16 text-green-500" />
      case 'error':
        return <XCircle className="h-16 w-16 text-red-500" />
      default:
        return <Mail className="h-16 w-16 text-blue-500 animate-pulse" />
    }
  }

  const getStatusTitle = () => {
    switch (verificationStatus) {
      case 'success':
        return t('Email Verified Successfully!')
      case 'error':
        return t('Verification Failed')
      default:
        return t('Verifying Your Email...')
    }
  }

  const getStatusDescription = () => {
    switch (verificationStatus) {
      case 'success':
        return t('Your email has been verified. You can now log in to your TermPocket account.')
      case 'error':
        return message ? t(message) : t('There was an error verifying your email address.')
      default:
        return t('Please wait while we verify your email address...')
    }
  }

  return (
    <>
      <Head>
        <title>Verify Email - TermPocket</title>
        <meta name="description" content="Verify your TermPocket account email" />
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
          <Card className="shadow-xl bg-card border border-border text-card-foreground">
            <CardHeader className="space-y-1 text-center">
              <div className="flex justify-center mb-4">
                {getStatusIcon()}
              </div>
              <CardTitle className="text-2xl text-green-700 dark:text-green-400">
                {getStatusTitle()}
              </CardTitle>
              <CardDescription className="text-center">
                {getStatusDescription()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {verificationStatus === 'success' && (
                <div className="space-y-4">
                  <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                    <p className="text-sm text-green-800 dark:text-green-200">
                      <strong>{t('Email:')}</strong> {userEmail}
                    </p>
                  </div>
                  <Button 
                    onClick={() => router.push('/login')}
                    className="w-full bg-green-600 hover:bg-green-700 text-white"
                  >
                    {t('Continue to Login')}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              )}

              {verificationStatus === 'error' && (
                <div className="space-y-4">
                  <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                    <p className="text-sm text-red-800 dark:text-red-200">
                      {message}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Button 
                      onClick={() => router.push('/login')}
                      className="w-full bg-green-600 hover:bg-green-700 text-white"
                    >
                      {t('Go to Login')}
                    </Button>
                    <Button 
                      onClick={() => router.push('/register')}
                      variant="outline"
                      className="w-full border-yellow-400 dark:border-yellow-500 text-yellow-700 dark:text-yellow-300"
                    >
                      {t('Register New Account')}
                    </Button>
                  </div>
                </div>
              )}

              {verificationStatus === 'loading' && (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600 mx-auto"></div>
                </div>
              )}
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
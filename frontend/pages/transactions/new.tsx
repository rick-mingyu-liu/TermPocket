import { useState } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { useForm } from 'react-hook-form'
import { ArrowLeft, Save, Calendar, DollarSign } from 'lucide-react'
import { api } from '@/utils/api'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTranslation } from 'next-i18next'
import { todayDay } from '@/lib/date';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';

interface TransactionForm {
  description: string
  amount: string
  type: 'income' | 'expense'
  category: string
  date: string
  notes: string
  currency: string // Add currency field
}

// The canonical category list. Anything that needs categories — the edit page,
// the dashboard's colour map, the backend validator — derives from this.
export const categories = {
  income: [
    'Salary',
    'Freelance',
    'Investment Returns',
    'Business',
    'Tax Refund',
    'Scholarships & Grants',
    'Refunds',
    'Gifts Received',
    'Other Income'
  ],
  expense: [
    'Groceries',
    'Dining Out',
    'Transportation',
    'Housing',
    'Utilities',
    'Entertainment',
    'Shopping',
    'Healthcare',
    'Education',
    'Travel',
    'Software & Apps',
    'Personal Care',
    'Fitness',
    'Gifts & Donations',
    'Fees & Charges',
    'Savings',
    'Other Expenses'
  ]
}

export default function NewTransaction() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [transactionType, setTransactionType] = useState<'income' | 'expense'>('expense')
  const { t } = useTranslation('common');
  
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<TransactionForm>({
    defaultValues: {
      type: 'expense',
      date: todayDay(),
      currency: 'CAD', // Default currency
    }
  })

  const onSubmit = async (data: TransactionForm) => {
    try {
      setLoading(true)
      
      await api.post('/transactions', {
        ...data,
        amount: parseFloat(data.amount),
        currency: data.currency,
      })
      
      toast.success(t('Transaction added successfully!'))
      router.push('/')
      
    } catch (error) {
      console.error('Transaction error:', error)
      // Error handling is done in api interceptor
    } finally {
      setLoading(false)
    }
  }

  const handleTypeChange = (type: 'income' | 'expense') => {
    setTransactionType(type)
    setValue('type', type)
    setValue('category', '')
  }

  return (
    <>
      <Head>
        <title>Add Transaction - TermPocket</title>
        <meta name="description" content="Add a new transaction" />
      </Head>

      <div className="min-h-screen bg-background">
        {/* Header */}
        <header className="border-b bg-card">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between py-6">
              <div className="flex items-center">
                <Button
                  variant="ghost"
                  onClick={() => router.push('/')}
                  className="mr-4 flex items-center"
                >
                  <ArrowLeft className="w-4 h-4 mr-2 sm:mr-2" />
                  <span className="hidden sm:inline">{t('Back to Dashboard')}</span>
                </Button>
                <div>
                  <h1 className="text-3xl font-bold">{t('Add Transaction')}</h1>
                  <p className="text-muted-foreground">{t('Record a new income or expense')}</p>
                </div>
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Card>
            <CardHeader>
              <CardTitle>{t('Transaction Details')}</CardTitle>
              <CardDescription>
                {t('Fill in the details of your transaction')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
                {/* Transaction Type */}
                <div className="space-y-2">
                  <Label>{t('Transaction Type')}</Label>
                  <div className="flex gap-4">
                    <Button
                      type="button"
                      variant={transactionType === 'expense' ? 'default' : 'outline'}
                      onClick={() => handleTypeChange('expense')}
                      className="flex-1"
                    >
                      <DollarSign className="w-4 h-4 mr-2" />
                      {t('Expense')}
                    </Button>
                    <Button
                      type="button"
                      variant={transactionType === 'income' ? 'default' : 'outline'}
                      onClick={() => handleTypeChange('income')}
                      className="flex-1"
                    >
                      <DollarSign className="w-4 h-4 mr-2" />
                      {t('Income')}
                    </Button>
                  </div>
                </div>

                {/* Description */}
                <div className="space-y-2">
                  <Label htmlFor="description">{t('Description')}</Label>
                  <Input
                    id="description"
                    placeholder={t('e.g., Grocery shopping, Salary payment')}
                    {...register('description', {
                      required: t('Description is required'),
                      minLength: {
                        value: 3,
                        message: t('Description must be at least 3 characters'),
                      },
                    })}
                  />
                  {errors.description && (
                    <p className="text-sm text-destructive">{errors.description.message}</p>
                  )}
                </div>

                {/* Amount */}
                <div className="space-y-2">
                  <Label htmlFor="amount">{t('Amount')}</Label>
                  <Input
                    id="amount"
                    type="number"
                    step="0.01"
                    placeholder={t('0.00')}
                    {...register('amount', {
                      required: t('Amount is required'),
                      min: {
                        value: 0.01,
                        message: t('Amount must be greater than 0'),
                      },
                    })}
                  />
                  {errors.amount && (
                    <p className="text-sm text-destructive">{errors.amount.message}</p>
                  )}
                </div>
                {/* Currency */}
                <div className="space-y-2">
                  <Label htmlFor="currency">{t('Currency')}</Label>
                  <Select
                    defaultValue="CAD"
                    {...register('currency', { required: 'Currency is required' })}
                    onValueChange={(value) => setValue('currency', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('Select currency')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CAD">{t('CAD ($)')}</SelectItem>
                      <SelectItem value="USD">{t('USD ($)')}</SelectItem>
                      <SelectItem value="CNY">{t('CNY (¥)')}</SelectItem>
                      <SelectItem value="EUR">{t('EUR (€)')}</SelectItem>
                      <SelectItem value="GBP">{t('GBP (£)')}</SelectItem>
                      <SelectItem value="AUD">{t('AUD (A$)')}</SelectItem>
                    </SelectContent>
                  </Select>
                  {errors.currency && (
                    <p className="text-sm text-destructive">{errors.currency.message}</p>
                  )}
                </div>

                {/* Category */}
                <div className="space-y-2">
                  <Label htmlFor="category">{t('Category')}</Label>
                  <Select onValueChange={(value) => setValue('category', value)}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('Select a category')} />
                    </SelectTrigger>
                    <SelectContent>
                      {categories[transactionType].map((category) => (
                        <SelectItem key={category} value={category}>
                          {t(category)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.category && (
                    <p className="text-sm text-destructive">{errors.category.message}</p>
                  )}
                </div>

                {/* Date */}
                <div className="space-y-2">
                  <Label htmlFor="date">{t('Date')}</Label>
                  <div className="relative">
                    <Calendar className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="date"
                      type="date"
                      className="pl-10"
                      {...register('date', {
                        required: t('Date is required'),
                      })}
                    />
                  </div>
                  {errors.date && (
                    <p className="text-sm text-destructive">{errors.date.message}</p>
                  )}
                </div>

                {/* Notes */}
                <div className="space-y-2">
                  <Label htmlFor="notes">{t('Notes (optional)')}</Label>
                  <Textarea
                    id="notes"
                    placeholder={t('Any additional notes about this transaction...')}
                    className="min-h-[100px]"
                    {...register('notes')}
                  />
                </div>

                {/* Hidden type field */}
                <input type="hidden" {...register('type')} />

                <div className="flex gap-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => router.push('/')}
                    className="flex-1"
                  >
                    {t('Cancel')}
                  </Button>
                  <Button type="submit" className="flex-1" disabled={loading}>
                    {loading ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                        {t('Saving...')}
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4 mr-2" />
                        {t('Save Transaction')}
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </main>
      </div>
    </>
  )
} 

export async function getStaticProps({ locale }: { locale: string }) {
  return {
    props: {
      ...(await serverSideTranslations(locale, ['common'])),
    },
  };
} 
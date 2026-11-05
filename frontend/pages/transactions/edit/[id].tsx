import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { ArrowLeft, Save, Trash2 } from 'lucide-react'
import axios from 'axios'
import { api } from '@/utils/api'
import { categories } from '../new'
import { Button } from '@/components/ui/button'
import { AppShell } from '@/components/AppShell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import Swal from 'sweetalert2'
import { useTranslation } from 'next-i18next'
import { toDay } from '@/lib/date';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';

interface Transaction {
  id: number
  description: string
  amount: number
  type: 'income' | 'expense'
  category: string
  date: string
  currency: string // Add currency field
}

// Derived from the canonical list rather than duplicated: the local copy had
// drifted, offering 'Investment' and 'Other' (which aren't real categories) while
// missing Business, Travel and Other Income.
const CATEGORIES = [...categories.income, ...categories.expense]

export default function EditTransaction() {
  const router = useRouter()
  const { id } = router.query
  const { t } = useTranslation('common');
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [formData, setFormData] = useState({
    description: '',
    amount: '',
    type: 'expense' as 'income' | 'expense',
    category: '',
    date: '',
    currency: 'CAD', // Default currency
  })

  useEffect(() => {
    if (id) {
      fetchTransaction()
    }
  }, [id])

  const fetchTransaction = async () => {
    try {
      setLoading(true)
      const response = await api.get(`/transactions/${id}`)
      const targetTransaction: Transaction = response.data.transaction

      setFormData({
        description: targetTransaction.description,
        amount: targetTransaction.amount.toString(),
        type: targetTransaction.type,
        category: targetTransaction.category,
        date: toDay(targetTransaction.date) ?? '',
        currency: targetTransaction.currency || 'CAD',
      })
    } catch (error) {
      console.error('Error fetching transaction:', error)
      const status = axios.isAxiosError(error) ? error.response?.status : undefined
      if (status === 404 || status === 400) {
        Swal.fire({
          icon: 'error',
          title: t('Transaction not found'),
          text: t('The transaction you are trying to edit does not exist.')
        })
      } else {
        Swal.fire({
          icon: 'error',
          title: t('Failed to load transaction'),
          text: t('There was an error loading the transaction. Please try again later.')
        })
      }
      router.push('/transactions')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!formData.description || !formData.amount || !formData.category || !formData.date) {
      Swal.fire({
        icon: 'error',
        title: t('Please fill in all required fields'),
        text: t('You must provide a description, amount, category, and date for the transaction.')
      })
      return
    }

    try {
      setSaving(true)
      await api.put(`/transactions/${id}`, {
        description: formData.description,
        amount: parseFloat(formData.amount),
        type: formData.type,
        category: formData.category,
        date: formData.date,
        currency: formData.currency,
      })

      Swal.fire({
        icon: 'success',
        title: t('Transaction updated successfully'),
        text: t('The transaction has been updated successfully.')
      })
      router.push('/transactions')
    } catch (error) {
      console.error('Error updating transaction:', error)
      Swal.fire({
        icon: 'error',
        title: t('Failed to update transaction'),
        text: t('There was an error updating the transaction. Please try again later.')
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    const result = await Swal.fire({
      title: t('Are you sure?'),
      text: t('Are you sure you want to delete this transaction? This action cannot be undone.'),
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d33',
      cancelButtonColor: '#3085d6',
      confirmButtonText: t('Yes, delete it!'),
      cancelButtonText: t('Cancel'),
    })
    if (!result.isConfirmed) {
      return
    }

    try {
      setDeleting(true)
      await api.delete(`/transactions/${id}`)
      Swal.fire({
        icon: 'success',
        title: t('Transaction deleted successfully'),
        text: t('The transaction has been deleted successfully.')
      })
      router.push('/transactions')
    } catch (error) {
      console.error('Error deleting transaction:', error)
      Swal.fire({
        icon: 'error',
        title: t('Failed to delete transaction'),
        text: t('There was an error deleting the transaction. Please try again later.')
      })
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    )
  }

  return (
    <>
      <Head>
        <title>Edit Transaction - TermPocket</title>
        <meta name="description" content="Edit your transaction" />
      </Head>

      <AppShell>
        {/* Header */}
        <div>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => router.push('/transactions')}
                >
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  {t('Back to Transactions')}
                </Button>
                <div>
                  <h1 className="text-3xl font-bold">{t('Edit Transaction')}</h1>
                  <p className="text-muted-foreground">
                    {t('Update your transaction details')}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-8">
          <div className="max-w-2xl mx-auto">
            <Card>
              <CardHeader>
                <CardTitle>{t('Edit Transaction')}</CardTitle>
                <CardDescription>{t('Update the details of your transaction')}</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* Description */}
                  <div className="space-y-2">
                    <Label htmlFor="description">{t('Description')} *</Label>
                    <Input
                      id="description"
                      placeholder={t('e.g., Grocery shopping, Salary payment')}
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      required
                    />
                  </div>

                  {/* Amount */}
                  <div className="space-y-2">
                    <Label htmlFor="amount">{t('Amount')} *</Label>
                    <Input
                      id="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder={t('0.00')}
                      value={formData.amount}
                      onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                      required
                    />
                  </div>
                  {/* Currency */}
                  <div className="space-y-2">
                    <Label htmlFor="currency">{t('Currency')} *</Label>
                    <Select
                      value={formData.currency}
                      onValueChange={(value) => setFormData({ ...formData, currency: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select currency" />
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
                  </div>

                  {/* Type */}
                  <div className="space-y-2">
                    <Label htmlFor="type">{t('Type')} *</Label>
                    <Select
                      value={formData.type}
                      onValueChange={(value: 'income' | 'expense') => setFormData({ ...formData, type: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="expense">{t('Expense')}</SelectItem>
                        <SelectItem value="income">{t('Income')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Category */}
                  <div className="space-y-2">
                    <Label htmlFor="category">{t('Category')} *</Label>
                    <Select
                      value={formData.category}
                      onValueChange={(value) => setFormData({ ...formData, category: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map((category) => (
                          <SelectItem key={category} value={category}>
                            {t(category)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Date */}
                  <div className="space-y-2">
                    <Label htmlFor="date">{t('Date')} *</Label>
                    <Input
                      id="date"
                      type="date"
                      value={formData.date}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      required
                    />
                  </div>

                  {/* Action Buttons: stacked below sm, Save on top; three labels do not fit one row at 375 px */}
                  <div className="flex flex-col-reverse gap-2 pt-6 sm:flex-row">
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="flex-1"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      {t('Delete Transaction')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => router.push('/transactions')}
                      className="flex-1"
                    >
                      {t('Cancel')}
                    </Button>
                    <Button
                      type="submit"
                      disabled={saving}
                      className="flex-1"
                    >
                      <Save className="w-4 h-4 mr-2" />
                      {t('Save Changes')}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>
        </div>
      </AppShell>
    </>
  )
} 

export async function getStaticPaths() {
  return { paths: [], fallback: 'blocking' as const }
}

export async function getStaticProps({ locale }: { locale: string }) {
  return {
    props: {
      ...(await serverSideTranslations(locale, ['common'])),
    },
  };
} 
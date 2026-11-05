import { useState, useEffect } from 'react'
import Head from 'next/head'
import { useForm } from 'react-hook-form'
import { Plus, Target, Calendar, Edit, Eye } from 'lucide-react'
import { api } from '@/utils/api'
import { Button } from '@/components/ui/button'
import { AppShell } from '@/components/AppShell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import Swal from 'sweetalert2'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { formatCurrency } from '@/utils/formatters';
import { useTranslation } from 'next-i18next'
import { toDay, formatDay, daysUntil } from '@/lib/date';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import GoalTopUpSuggestion from '@/components/GoalTopUpSuggestion';

interface Goal {
  id: number
  name: string
  target_amount: number
  current_amount: number
  target_date: string
  description: string
  currency: string // Add currency to Goal
}

interface GoalForm {
  name: string
  target_amount: string
  current_amount: string
  target_date: string
  description: string
  currency: string // Add currency to GoalForm
}

function GoalDescriptionPreview({ description }: { description: string }) {
  return (
    <div className="mt-1">
      <div className="bg-muted/60 rounded-md px-3 py-2 text-sm relative">
        <div className="clamp-5-lines relative pr-2 whitespace-pre-wrap break-words">
          {description}
          <div className="fade-bottom pointer-events-none" />
        </div>
      </div>
    </div>
  );
}

export default function Goals() {
  const { t } = useTranslation('common');
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null)
  const [viewingGoal, setViewingGoal] = useState<Goal | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [goalToDelete, setGoalToDelete] = useState<Goal | null>(null)
  
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
    watch,
    setValue,
  } = useForm<GoalForm>()

  useEffect(() => {
    fetchGoals()
  }, [])

  const fetchGoals = async () => {
    try {
      setLoading(true)
      const response = await api.get('/goals')
      setGoals(response.data.goals)
    } catch (error) {
      console.error('Error fetching goals:', error)
    } finally {
      setLoading(false)
    }
  }

  const onSubmit = async (data: GoalForm) => {
    try {
      if (editingGoal) {
        await api.put(`/goals/${editingGoal.id}`, {
          ...data,
          target_amount: parseFloat(data.target_amount),
          current_amount: parseFloat(data.current_amount),
        })
        Swal.fire({
          icon: 'success',
          title: t('Goal updated successfully!'),
        })
      } else {
        await api.post('/goals', {
          ...data,
          target_amount: parseFloat(data.target_amount),
          current_amount: parseFloat(data.current_amount),
        })
        Swal.fire({
          icon: 'success',
          title: t('Goal created successfully!'),
        })
      }
      
      setIsDialogOpen(false)
      reset()
      setEditingGoal(null)
      fetchGoals()
      
    } catch (error) {
      console.error('Goal error:', error)
    }
  }

  const handleEdit = (goal: Goal) => {
    setEditingGoal(goal);
    const formattedDate = goal.target_date
      ? toDay(goal.target_date) ?? ''
      : '';
    reset({
      name: goal.name,
      target_amount: goal.target_amount.toString(),
      current_amount: goal.current_amount.toString(),
      target_date: formattedDate,
      description: goal.description,
      currency: goal.currency, // Ensure currency is set
    });
    setIsDialogOpen(true);
  }

  if (loading) {
    return (
      <AppShell>
        <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
        </div>
      </AppShell>
    )
  }

  return (
    <>
      <Head>
        <title>{`${t('Savings Goals')} - TermPocket`}</title>
        <meta name="description" content={t('Manage your savings goals')} />
      </Head>

      <AppShell>
        {/* Header */}
        <header>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pt-8 gap-4 sm:gap-0">
              <div className="flex items-center">
                <div>
                  <h1 className="text-3xl font-bold">{t('Savings Goals')}</h1>
                  <p className="text-muted-foreground">{t('Track and manage your financial goals')}</p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                  <DialogTrigger asChild>
                    <Button className="w-full sm:w-auto">
                      <Plus className="w-4 h-4 mr-2" />
                      {t('Add Goal')}
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle>
                        {editingGoal ? t('Edit Goal') : t('Create New Goal')}
                      </DialogTitle>
                      <DialogDescription>
                        {t('Set up a new savings goal with target amount and timeline')}
                      </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="name">{t('Goal Name')}</Label>
                        <Input
                          id="name"
                          placeholder={t('e.g., Emergency Fund, House Down Payment')}
                          {...register('name', {
                            required: t('Goal name is required'),
                          })}
                        />
                        {errors.name && (
                          <p className="text-sm text-destructive">{errors.name.message}</p>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="target_amount">{t('Target Amount')}</Label>
                          <Input
                            id="target_amount"
                            type="number"
                            step="0.01"
                            placeholder={t('0.00')}
                            {...register('target_amount', {
                              required: t('Target amount is required'),
                              min: {
                                value: 0.01,
                                message: t('Target amount must be greater than 0'),
                              },
                            })}
                          />
                          {errors.target_amount && (
                            <p className="text-sm text-destructive">{errors.target_amount.message}</p>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="current_amount">{t('Current Amount')}</Label>
                          <Input
                            id="current_amount"
                            type="number"
                            step="0.01"
                            placeholder={t('0.00')}
                            {...register('current_amount', {
                              required: t('Current amount is required'),
                              min: {
                                value: 0,
                                message: t('Current amount cannot be negative'),
                              },
                            })}
                          />
                          {errors.current_amount && (
                            <p className="text-sm text-destructive">{errors.current_amount.message}</p>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="target_date">{t('Target Date')} <span className="text-red-500">*</span></Label>
                          <Input
                            id="target_date"
                            type="date"
                            placeholder={t('Select a date')}
                            aria-invalid={!!errors.target_date}
                            aria-describedby={errors.target_date ? 'target_date-error' : undefined}
                            className={errors.target_date ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''}
                            {...register('target_date', {
                              required: t('Target date is required'),
                            })}
                          />
                          {errors.target_date && (
                            <p id="target_date-error" className="text-sm font-semibold text-red-600 flex items-center gap-1 mt-1">
                              <Calendar className="w-4 h-4 text-red-500" /> {errors.target_date.message}
                            </p>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="currency">{t('Currency')}</Label>
                          <Select
                            value={watch('currency') || 'CAD'}
                            onValueChange={value => setValue('currency', value, { shouldValidate: true })}
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
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="description">{t('Description (optional)')}</Label>
                        <Textarea
                          id="description"
                          placeholder={t('Additional details about your goal...')}
                          {...register('description')}
                          className="min-h-[360px]"
                        />
                      </div>

                      <div className="flex gap-2">
                        {editingGoal ? (
                          <Button
                            type="button"
                            variant="destructive"
                            className="flex-1"
                            onClick={() => {
                              setGoalToDelete(editingGoal);
                              setDeleteDialogOpen(true);
                            }}
                          >
                            {t('Delete Goal')}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setIsDialogOpen(false)
                              reset()
                              setEditingGoal(null)
                            }}
                            className="flex-1"
                          >
                            {t('Cancel')}
                          </Button>
                        )}
                        <Button type="submit" className="flex-1">
                          {editingGoal ? t('Update Goal') : t('Create Goal')}
                        </Button>
                      </div>
                    </form>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8 pt-6 pb-8">
          <GoalTopUpSuggestion goals={goals} onAdded={fetchGoals} />
          {goals.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12">
                <Target className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-medium mb-2">{t('No savings goals yet')}</h3>
                <p className="text-muted-foreground mb-4">
                  {t('Create your first savings goal to start tracking your progress')}
                </p>
                <Button onClick={() => setIsDialogOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  {t('Create Your First Goal')}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {goals.map((goal) => {
                const progress = (goal.current_amount / goal.target_amount) * 100
                const daysRemaining = daysUntil(goal.target_date) ?? 0
                const progressColor = progress >= 100 ? 'bg-green-500' : progress >= 75 ? 'bg-blue-500' : progress >= 50 ? 'bg-yellow-500' : 'bg-red-500';
                return (
                  <Card
                    key={goal.id}
                    className="relative cursor-pointer hover:shadow-lg transition-shadow"
                    onClick={() => {
                      if (window.innerWidth < 640) setViewingGoal(goal);
                    }}
                  >
                    {/* Progress color bar */}
                    <div className={`absolute top-0 left-0 w-full h-1 rounded-t-xl ${progressColor}`} />
                    <CardHeader>
                      <div className="flex items-start justify-between w-full">
                        <CardTitle className="text-lg flex-1">{goal.name}</CardTitle>
                        <div className="flex gap-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('View Goal')}
                            onClick={e => { e.stopPropagation(); setViewingGoal(goal); }}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={e => { e.stopPropagation(); handleEdit(goal); }}
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="mt-2">
                        <GoalDescriptionPreview description={goal.description || t('No description provided')} />
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-2">
                        <div className="flex justify-between text-base font-semibold">
                          <span className="text-muted-foreground">{t('Progress')}</span>
                          <span className="font-bold">{progress.toFixed(1)}%</span>
                        </div>
                        <Progress value={progress} className="h-3" />
                      </div>
                      <div className="grid grid-cols-2 gap-4 text-base">
                        <div>
                          <p className="text-muted-foreground">{t('Current')}</p>
                          <p className="font-bold text-green-600 text-lg">{formatCurrency(goal.current_amount, goal.currency)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">{t('Target')}</p>
                          <p className="font-bold text-lg">{formatCurrency(goal.target_amount, goal.currency)}</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Calendar className="w-5 h-5 text-muted-foreground" />
                          <span className="text-base text-muted-foreground">
                            {formatDay(goal.target_date)}
                          </span>
                        </div>
                        <Badge variant={daysRemaining < 0 ? "destructive" : daysRemaining < 30 ? "default" : "secondary"} className="text-base px-3 py-1 rounded-full">
                          {daysRemaining < 0 ? t('Overdue') : `${daysRemaining} ${t('days left')}`}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </main>
      </AppShell>

      <Dialog open={!!viewingGoal} onOpenChange={open => { if (!open) setViewingGoal(null) }}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('Goal Details')}</DialogTitle>
            <DialogDescription>
              {t('View your goal details')}
            </DialogDescription>
          </DialogHeader>
          {viewingGoal && (
            <div className="space-y-6">
              <div>
                <Label className="font-semibold">{t('Goal Name')}</Label>
                <div className="mt-1 text-lg">{viewingGoal.name}</div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="font-semibold">{t('Target Amount ($)')}</Label>
                  <div className="mt-1">{viewingGoal.target_amount}</div>
                </div>
                <div>
                  <Label className="font-semibold">{t('Current Amount ($)')}</Label>
                  <div className="mt-1">{viewingGoal.current_amount}</div>
                </div>
              </div>
              <div>
                <Label className="font-semibold">{t('Target Date')}</Label>
                <div className="mt-1">{toDay(viewingGoal.target_date) ?? ''}</div>
              </div>
              <div>
                <Label className="font-semibold">{t('Description')}</Label>
                <div className="mt-1 text-sm bg-muted/60 rounded-md px-3 py-2 whitespace-pre-wrap break-words">
                  {viewingGoal.description}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Delete Goal')}</DialogTitle>
            <DialogDescription>
              {t('Are you sure you want to delete this goal? This action cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 mt-4">
            <Button
              variant="destructive"
              onClick={async () => {
                if (goalToDelete) {
                  await api.delete(`/goals/${goalToDelete.id}`);
                  Swal.fire({
                    icon: 'success',
                    title: t('Goal deleted successfully!'),
                  })
                  setDeleteDialogOpen(false);
                  setViewingGoal(null);
                  setIsDialogOpen(false);
                  setEditingGoal(null);
                  setGoalToDelete(null);
                  fetchGoals();
                }
              }}
            >
              {t('Delete')}
            </Button>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              {t('Cancel')}
            </Button>
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
  };
} 